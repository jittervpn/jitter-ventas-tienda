// Firestore vía firebase-admin. Variable en Vercel: FIREBASE_SERVICE_ACCOUNT = JSON completo de la service account.
// La inicialización es perezosa para que, si falta la variable, solo fallen las rutas de pago.
import admin from "firebase-admin";

export function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.firestore();
}
export { admin };

/** Beneficios pagos del usuario: { ssh_expires_at, dns_expires_at } (ms; 0 = sin plan). */
export async function beneficios(uid) {
  const d = await getDb().collection("usuarios").doc(uid).get();
  const x = d.exists ? d.data() : {};
  return { ssh_expires_at: x.ssh_expires_at || 0, dns_expires_at: x.dns_expires_at || 0 };
}
