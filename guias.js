(function () {
  var a = document.querySelector('article[data-art]'); if (!a) return;
  var meta = a.querySelector('.meta');
  var min = Math.max(1, Math.round((a.innerText || '').split(/\s+/).length / 200));
  if (meta) meta.textContent += '. Lectura de ' + min + ' min.';
  var hs = [].slice.call(a.querySelectorAll('h2')).filter(function (h) { return !/Sigue aprendiendo/.test(h.textContent); });
  if (hs.length >= 3) {
    var ol = document.createElement('ol');
    hs.forEach(function (h, i) {
      h.id = h.id || 's' + (i + 1);
      var li = document.createElement('li'), l = document.createElement('a');
      l.href = '#' + h.id; l.textContent = h.textContent; li.appendChild(l); ol.appendChild(li);
    });
    var t = document.createElement('nav'); t.className = 'toc'; t.setAttribute('aria-label', 'Contenido');
    t.innerHTML = '<b>En esta guía</b>'; t.appendChild(ol);
    hs[0].parentNode.insertBefore(t, hs[0]);
  }
  var c = document.createElement('aside'); c.className = 'cta-card';
  c.innerHTML = '<h3>¿Listo para probarlo?</h3><p>Contrata tu CDN CloudFront en menos de un minuto: $17.000 por 30 días, con pago por Mercado Pago.</p><a class="cta" href="/#cdn">Contratar CDN</a>';
  var rel = [].slice.call(a.querySelectorAll('h2')).filter(function (h) { return /Sigue aprendiendo/.test(h.textContent); })[0];
  a.insertBefore(c, rel || null);
})();
