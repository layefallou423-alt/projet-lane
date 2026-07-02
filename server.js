/**
 * Bot WhatsApp — Vente de fiches de cours (PC Terminale/Première)
 * ------------------------------------------------------------
 * Fonctionne avec Twilio WhatsApp API (gratuit en mode Sandbox pour tester).
 * Le bot : accueille l'élève -> montre les matières/chapitres dispo ->
 * donne un lien de paiement PayTech -> une fois payé, envoie le PDF/lien du chapitre.
 *
 * IMPORTANT : ce fichier ne contient AUCUNE clé secrète. Toutes les clés
 * vont dans le fichier .env (jamais dans le code, jamais partagé publiquement).
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER; // ex: "whatsapp:+14155238886"

const client = twilio(accountSid, authToken);

// ---------------------------------------------------------------
// 1. CATALOGUE — à modifier/compléter au fur et à mesure que tu
//    ajoutes des chapitres. C'est ici que tu gères tout ton contenu.
// ---------------------------------------------------------------
const CATALOGUE = {
  "1": {
    matiere: "Physique-Chimie Terminale",
    chapitre: "Les Alcools",
    prix: 100, // en FCFA
    lien_paiement: "https://paytech.sn/payment/xxxxxx", // lien généré depuis ton compte PayTech
    lien_contenu: "https://lien-vers-ton-fichier-sur-drive.com/alcools.pdf",
  },
  "2": {
    matiere: "Physique-Chimie Terminale",
    chapitre: "Les Amines",
    prix: 100,
    lien_paiement: "https://paytech.sn/payment/yyyyyy",
    lien_contenu: "https://lien-vers-ton-fichier-sur-drive.com/amines.pdf",
  },
  // Ajoute ici tes prochains chapitres au même format...
};

// ---------------------------------------------------------------
// 2. ÉTAT DE CONVERSATION (en mémoire — simple pour démarrer)
//    Pour un vrai lancement, on remplacera ça par une petite base
//    de données (voir note en bas de fichier).
// ---------------------------------------------------------------
const sessions = {}; // { "whatsapp:+221xxxxxxxxx": { etape: "menu" } }

// ---------------------------------------------------------------
// 3. WEBHOOK PRINCIPAL — reçoit chaque message de l'élève
// ---------------------------------------------------------------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From; // ex: "whatsapp:+221708906141"
  const body = (req.body.Body || "").trim();

  if (!sessions[from]) {
    sessions[from] = { etape: "accueil" };
  }
  const session = sessions[from];

  let reponse = "";

  // --- Étape ACCUEIL ---
  if (session.etape === "accueil" || body.toLowerCase() === "menu") {
    reponse = construireMenu();
    session.etape = "choix_chapitre";
  }

  // --- Étape CHOIX D'UN CHAPITRE ---
  else if (session.etape === "choix_chapitre") {
    const item = CATALOGUE[body];
    if (item) {
      session.etape = "attente_paiement";
      session.chapitreChoisi = body;
      reponse =
        `Tu as choisi : *${item.chapitre}* (${item.matiere})\n` +
        `Prix : ${item.prix} FCFA\n\n` +
        `Paye ici (Wave, Orange Money ou carte) :\n${item.lien_paiement}\n\n` +
        `Une fois payé, écris *"payé"* ici et je t'envoie le fichier direct.`;
    } else {
      reponse =
        "Je n'ai pas compris. Réponds avec le numéro du chapitre.\n\n" +
        construireMenu();
    }
  }

  // --- Étape ATTENTE DE CONFIRMATION DE PAIEMENT ---
  else if (session.etape === "attente_paiement") {
    if (body.toLowerCase().includes("pay")) {
      const item = CATALOGUE[session.chapitreChoisi];
      // ⚠️ Pour l'instant on envoie directement après le mot "payé".
      // Étape suivante recommandée : vérifier automatiquement le paiement
      // via le webhook PayTech avant d'envoyer (voir note en bas de fichier).
      reponse =
        `Merci ! Voici ton fichier :\n${item.lien_contenu}\n\n` +
        `Tape *menu* pour voir d'autres chapitres.`;
      session.etape = "accueil";
    } else {
      reponse =
        "Dis-moi *payé* une fois le paiement fait, ou tape *menu* pour changer de chapitre.";
    }
  }

  // Envoi de la réponse via Twilio
  await client.messages.create({
    from: twilioWhatsAppNumber,
    to: from,
    body: reponse,
  });

  res.sendStatus(200);
});

function construireMenu() {
  let texte = "Bienvenue ! Voici les chapitres disponibles :\n\n";
  for (const [num, item] of Object.entries(CATALOGUE)) {
    texte += `*${num}.* ${item.chapitre} (${item.matiere}) — ${item.prix} FCFA\n`;
  }
  texte += "\nRéponds avec le numéro du chapitre qui t'intéresse.";
  return texte;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot lancé sur le port ${PORT}`));

/**
 * NOTES POUR LA SUITE (pas urgent, mais à savoir) :
 *
 * 1. VÉRIFICATION AUTOMATIQUE DU PAIEMENT
 *    Actuellement, le bot fait confiance quand l'élève écrit "payé" —
 *    ce n'est pas sécurisé (quelqu'un pourrait mentir). PayTech propose
 *    un système de "callback" : quand un paiement réussit vraiment,
 *    PayTech appelle une URL de ton serveur pour te le confirmer.
 *    On pourra brancher ça plus tard pour automatiser complètement.
 *
 * 2. BASE DE DONNÉES
 *    Le tableau `sessions` est en mémoire : si le serveur redémarre,
 *    tout est perdu. Pour un usage sérieux, on migrera vers une petite
 *    base (SQLite ou Google Sheets comme base simple) — je peux le faire
 *    quand tu es prêt à passer à l'échelle.
 */
