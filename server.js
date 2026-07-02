/**
 * Bot WhatsApp — Vente de fiches de cours (PC Terminale/Première)
 * ------------------------------------------------------------
 * Fonctionne avec Twilio WhatsApp API + PayTech (paiement Wave/Orange Money).
 *
 * Flux :
 * 1. L'élève écrit au bot (numéro ou texte libre du chapitre voulu)
 * 2. Le bot génère un VRAI lien de paiement via l'API PayTech
 * 3. L'élève paie sur ce lien
 * 4. PayTech notifie automatiquement notre serveur (IPN) que le paiement est confirmé
 * 5. Le bot envoie automatiquement le fichier à l'élève, SANS qu'il ait besoin
 *    d'écrire "payé" — la vérification est maintenant automatique et fiable.
 *
 * IMPORTANT : ce fichier ne contient AUCUNE clé secrète. Toutes les clés
 * vont dans le fichier .env (jamais dans le code, jamais partagé publiquement).
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER; // ex: "whatsapp:+14155238886"
const twilioClient = twilio(accountSid, authToken);

const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;
const PAYTECH_ENV = process.env.PAYTECH_ENV || "test"; // "test" ou "prod"

// L'adresse publique de TON bot sur Render, ex: https://whatsapp-bot-cours.onrender.com
// (sans slash à la fin)
const BASE_URL = process.env.BASE_URL;

// ---------------------------------------------------------------
// 1. CATALOGUE — à modifier/compléter au fur et à mesure que tu
//    ajoutes des chapitres. C'est ici que tu gères tout ton contenu.
//
//    "mots_cles" = les mots que l'élève pourrait taper pour désigner
//    ce chapitre. Mets-en plusieurs variantes (accents, abréviations).
// ---------------------------------------------------------------
const CATALOGUE = {
  "1": {
    matiere: "Physique-Chimie Terminale",
    chapitre: "Les Alcools",
    prix: 100, // en FCFA
    lien_contenu: "https://lien-vers-ton-fichier-sur-drive.com/alcools.pdf",
    mots_cles: ["alcool", "alcools", "pc terminale", "chimie terminale"],
  },
  "2": {
    matiere: "Physique-Chimie Terminale",
    chapitre: "Les Amines",
    prix: 100,
    lien_contenu: "https://lien-vers-ton-fichier-sur-drive.com/amines.pdf",
    mots_cles: ["amine", "amines"],
  },
  // Ajoute ici tes prochains chapitres au même format...
};

function normaliser(texte) {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function chercherParMotsCles(messageBrut) {
  const message = normaliser(messageBrut);
  const resultats = [];
  for (const [num, item] of Object.entries(CATALOGUE)) {
    const trouve = item.mots_cles.some((mot) =>
      message.includes(normaliser(mot))
    );
    if (trouve) resultats.push(num);
  }
  return resultats;
}

// ---------------------------------------------------------------
// 2. ÉTAT DE CONVERSATION (en mémoire)
// ---------------------------------------------------------------
const sessions = {}; // { "whatsapp:+221xxxxxxxxx": { etape } }

// Commandes en attente de paiement, indexées par leur référence unique.
// On s'en sert pour retrouver "qui a commandé quoi" quand PayTech nous
// notifie qu'un paiement est terminé.
const commandesEnAttente = {}; // { ref_command: { phone, chapitreNum } }

// ---------------------------------------------------------------
// 3. GÉNÉRER UN VRAI LIEN DE PAIEMENT PAYTECH
// ---------------------------------------------------------------
async function creerLienPaiement(chapitreNum, phone) {
  const item = CATALOGUE[chapitreNum];
  const refCommand = `CMD_${Date.now()}_${chapitreNum}`;

  const params = {
    item_name: item.chapitre,
    item_price: item.prix,
    currency: "XOF",
    ref_command: refCommand,
    command_name: `${item.chapitre} (${item.matiere})`,
    env: PAYTECH_ENV,
    ipn_url: `${BASE_URL}/ipn`,
    success_url: `${BASE_URL}/success`,
    cancel_url: `${BASE_URL}/cancel`,
    custom_field: JSON.stringify({ phone, chapitreNum }),
  };

  const response = await fetch("https://paytech.sn/api/payment/request-payment", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      API_KEY: PAYTECH_API_KEY,
      API_SECRET: PAYTECH_API_SECRET,
    },
    body: JSON.stringify(params),
  });

  const data = await response.json();

  if (data.success === 1) {
    // On mémorise la commande pour pouvoir la retrouver quand l'IPN arrive
    commandesEnAttente[refCommand] = { phone, chapitreNum };
    return data.redirect_url;
  } else {
    console.error("Erreur PayTech:", data.message);
    return null;
  }
}

// ---------------------------------------------------------------
// 4. WEBHOOK PRINCIPAL WHATSAPP — reçoit chaque message de l'élève
// ---------------------------------------------------------------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From; // ex: "whatsapp:+221708906141"
  const body = (req.body.Body || "").trim();

  if (!sessions[from]) {
    sessions[from] = { etape: "accueil" };
  }
  const session = sessions[from];

  let reponse = "";

  const correspondances =
    body.toLowerCase() !== "menu" ? chercherParMotsCles(body) : [];

  if (correspondances.length === 1) {
    const num = correspondances[0];
    reponse = await proposerPaiement(num, from);
  } else if (correspondances.length > 1) {
    let texte = "J'ai trouvé plusieurs chapitres qui correspondent :\n\n";
    for (const num of correspondances) {
      const item = CATALOGUE[num];
      texte += `*${num}.* ${item.chapitre} (${item.matiere}) — ${item.prix} FCFA\n`;
    }
    texte += "\nRéponds avec le numéro qui t'intéresse.";
    reponse = texte;
    session.etape = "choix_chapitre";
  } else if (session.etape === "accueil" || body.toLowerCase() === "menu") {
    reponse = construireMenu();
    session.etape = "choix_chapitre";
  } else if (session.etape === "choix_chapitre") {
    if (CATALOGUE[body]) {
      reponse = await proposerPaiement(body, from);
    } else {
      reponse =
        "Je n'ai pas compris. Réponds avec le numéro du chapitre.\n\n" +
        construireMenu();
    }
  } else {
    // Cas par défaut : élève déjà en attente de paiement, on lui rappelle
    reponse =
      "Ton paiement n'est pas encore confirmé. Une fois payé, je t'envoie le fichier automatiquement — pas besoin de m'écrire.\n\n" +
      "Tape *menu* pour voir d'autres chapitres.";
  }

  await twilioClient.messages.create({
    from: twilioWhatsAppNumber,
    to: from,
    body: reponse,
  });

  res.sendStatus(200);
});

async function proposerPaiement(chapitreNum, from) {
  const item = CATALOGUE[chapitreNum];
  const phone = from.replace("whatsapp:", "");
  const lienPaiement = await creerLienPaiement(chapitreNum, phone);

  sessions[from].etape = "attente_paiement";
  sessions[from].chapitreChoisi = chapitreNum;

  if (!lienPaiement) {
    return "Désolé, une erreur est survenue avec le paiement. Réessaie dans quelques instants ou tape *menu*.";
  }

  return (
    `Tu as choisi : *${item.chapitre}* (${item.matiere})\n` +
    `Prix : ${item.prix} FCFA\n\n` +
    `Paye ici (Wave, Orange Money ou carte) :\n${lienPaiement}\n\n` +
    `Dès que ton paiement est confirmé, je t'envoie le fichier automatiquement — pas besoin de m'écrire "payé".`
  );
}

function construireMenu() {
  let texte = "Bienvenue ! Voici les chapitres disponibles :\n\n";
  for (const [num, item] of Object.entries(CATALOGUE)) {
    texte += `*${num}.* ${item.chapitre} (${item.matiere}) — ${item.prix} FCFA\n`;
  }
  texte += "\nRéponds avec le numéro du chapitre qui t'intéresse.";
  return texte;
}

// ---------------------------------------------------------------
// 5. IPN — PayTech nous appelle ICI automatiquement quand un
//    paiement est confirmé (ou annulé). C'est le cœur de la
//    vérification automatique.
// ---------------------------------------------------------------
app.post("/ipn", async (req, res) => {
  const {
    type_event,
    ref_command,
    item_price,
    final_item_price,
    api_key_sha256,
    api_secret_sha256,
    hmac_compute,
  } = req.body;

  // Vérification de sécurité : on s'assure que la notification vient bien
  // de PayTech, et pas de quelqu'un qui essaie de se faire passer pour lui.
  const estAuthentique = verifierIPN({
    item_price: final_item_price || item_price,
    ref_command,
    api_key_sha256,
    api_secret_sha256,
    hmac_compute,
  });

  if (!estAuthentique) {
    console.warn("IPN reçu mais non authentifié — ignoré.");
    return res.status(403).send("Forbidden");
  }

  const commande = commandesEnAttente[ref_command];
  if (!commande) {
    console.warn(`IPN reçu pour une commande inconnue : ${ref_command}`);
    return res.status(200).send("OK"); // on répond quand même 200 à PayTech
  }

  if (type_event === "sale_complete") {
    const item = CATALOGUE[commande.chapitreNum];
    const to = `whatsapp:${commande.phone}`;

    await twilioClient.messages.create({
      from: twilioWhatsAppNumber,
      to,
      body:
        `✅ Paiement confirmé ! Voici ton fichier :\n${item.lien_contenu}\n\n` +
        `Tape *menu* pour voir d'autres chapitres.`,
    });

    if (sessions[to]) sessions[to].etape = "accueil";
    delete commandesEnAttente[ref_command];
  } else if (type_event === "sale_canceled") {
    const to = `whatsapp:${commande.phone}`;
    await twilioClient.messages.create({
      from: twilioWhatsAppNumber,
      to,
      body: "Ton paiement a été annulé. Tape *menu* pour réessayer.",
    });
    delete commandesEnAttente[ref_command];
  }

  res.status(200).send("OK");
});

function verifierIPN({ item_price, ref_command, api_key_sha256, api_secret_sha256, hmac_compute }) {
  // Méthode 1 : HMAC (recommandée par PayTech, utilisée si présente)
  if (hmac_compute) {
    const message = `${item_price}|${ref_command}|${PAYTECH_API_KEY}`;
    const expected = crypto
      .createHmac("sha256", PAYTECH_API_SECRET)
      .update(message)
      .digest("hex");
    return expected === hmac_compute;
  }

  // Méthode 2 : comparaison des clés hachées (méthode de secours)
  const expectedKeyHash = crypto.createHash("sha256").update(PAYTECH_API_KEY).digest("hex");
  const expectedSecretHash = crypto.createHash("sha256").update(PAYTECH_API_SECRET).digest("hex");
  return expectedKeyHash === api_key_sha256 && expectedSecretHash === api_secret_sha256;
}

// Pages simples affichées au navigateur de l'élève après le paiement
// (PayTech y redirige automatiquement une fois le paiement terminé)
app.get("/success", (req, res) => {
  res.send("Paiement reçu ! Retourne sur WhatsApp, ton fichier arrive dans quelques secondes.");
});
app.get("/cancel", (req, res) => {
  res.send("Paiement annulé. Tu peux réessayer depuis WhatsApp en tapant menu.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot lancé sur le port ${PORT}`));

/**
 * NOTES POUR LA SUITE :
 *
 * 1. BASE DE DONNÉES
 *    `sessions` et `commandesEnAttente` sont en mémoire : si le serveur
 *    redémarre (Render le fait de temps en temps), tout est perdu. Pour un
 *    usage sérieux à plus grande échelle, on migrera vers une vraie base
 *    (ex: SQLite, ou une simple feuille Google Sheets). Dis-le-moi quand
 *    tu es prêt à passer à l'échelle.
 *
 * 2. PASSAGE EN MODE PRODUCTION (vrais paiements)
 *    Tant que PAYTECH_ENV=test, les paiements sont simulés (montant
 *    aléatoire 100-150 FCFA débité, peu importe le vrai prix). Une fois
 *    ton compte PayTech activé en production (après envoi de tes
 *    documents), passe PAYTECH_ENV à "prod" dans Render.
 */
