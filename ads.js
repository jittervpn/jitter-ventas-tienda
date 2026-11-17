/* Anuncios (Adsterra Social Bar). Solo se cargan para VISITANTES en jitterxcloud.shop:
   nunca si hay una sesión iniciada (clientes con contraseñas en pantalla), ni en otros dominios. */
(function () {
  var SRC = 'https://bauval.org/14/01b4441dd2ebe163e1c2c56655b9dee0';
  var SOLO_VISITANTES = true;   // false = también a clientes con sesión (NO recomendado)
  if (!/(^|\.)jitterxcloud\.shop$/.test(location.hostname)) return;
  try { if (SOLO_VISITANTES && localStorage.getItem('jx_token')) return; } catch (e) {}
  var s = document.createElement('script');
  s.src = SRC; s.async = true; s.setAttribute('data-cfasync', 'false');
  document.head.appendChild(s);
  window.__adsOn = true;
})();
