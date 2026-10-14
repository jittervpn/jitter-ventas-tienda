// Catálogo de planes. El precio SIEMPRE se define acá (servidor),
// nunca se acepta un precio que venga del navegador.
// >>> Editá precios y títulos a gusto (moneda: ARS). <<<
export const PLANES = {
  ssh_30: { titulo: "Cuenta SSH · 30 días", precio: 3000, dias: 30, campo: "ssh_expires_at" },
  dns_30: { titulo: "Subdominio · 30 días", precio: 1500, dias: 30, campo: "dns_expires_at" },
};
