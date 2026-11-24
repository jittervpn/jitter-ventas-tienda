(function () {
  var en = document.documentElement.lang === 'en';
  var T = en ? { lect: '. %d min read.', toc: 'In this guide', mas: /Keep learning/, ctaT: 'Ready to try it?', ctaD: 'Get your CloudFront CDN in under a minute: <span class="jx-precio">$17.000</span> for 30 days, paid by card, Mercado Pago or PayPal.', cta: 'Get CDN', idx: 'Contents' }
             : { lect: '. Lectura de %d min.', toc: 'En esta guía', mas: /Sigue aprendiendo/, ctaT: '¿Listo para probarlo?', ctaD: 'Contrata tu CDN CloudFront en menos de un minuto: <span class="jx-precio">$17.000</span> por 30 días, con tarjeta, Mercado Pago o PayPal.', cta: 'Contratar CDN', idx: 'Contenido' };
  // idioma: recordar la elección para el panel
  try {
    if (en && !localStorage.getItem('jx_lang')) localStorage.setItem('jx_lang', 'en');
    [].forEach.call(document.querySelectorAll('.langsw a[data-lang]'), function (a) { a.addEventListener('click', function () { try { localStorage.setItem('jx_lang', a.getAttribute('data-lang')); } catch (e) {} }); });
  } catch (e) {}
  var a = document.querySelector('article[data-art]');
  if (a) {
    var meta = a.querySelector('.meta');
    var min = Math.max(1, Math.round((a.innerText || '').split(/\s+/).length / 200));
    if (meta) meta.textContent += T.lect.replace('%d', min);
    var hs = [].slice.call(a.querySelectorAll('h2')).filter(function (h) { return !T.mas.test(h.textContent); });
    if (hs.length >= 3) {
      var ol = document.createElement('ol');
      hs.forEach(function (h, i) {
        h.id = h.id || 's' + (i + 1);
        var li = document.createElement('li'), l = document.createElement('a');
        l.href = '#' + h.id; l.textContent = h.textContent; li.appendChild(l); ol.appendChild(li);
      });
      var t = document.createElement('nav'); t.className = 'toc'; t.setAttribute('aria-label', T.idx);
      t.innerHTML = '<b>' + T.toc + '</b>'; t.appendChild(ol);
      hs[0].parentNode.insertBefore(t, hs[0]);
    }
    var c = document.createElement('aside'); c.className = 'cta-card';
    c.innerHTML = '<h3>' + T.ctaT + '</h3><p>' + T.ctaD + '</p><a class="cta" href="/#cdn">' + T.cta + '</a>';
    var rel = [].slice.call(a.querySelectorAll('h2')).filter(function (h) { return T.mas.test(h.textContent); })[0];
    a.insertBefore(c, rel || null);
  }
  // precio actual (se cambia desde el admin)
  if (document.querySelector('.jx-precio') && window.fetch) {
    fetch('/api/planes').then(function (r) { return r.json(); }).then(function (c) {
      var it = (c.items || []).filter(function (x) { return x.id === 'cdn30'; })[0]; if (!it || !it.precio) return;
      var txt = '$' + Number(it.precio).toLocaleString('es-AR');
      [].forEach.call(document.querySelectorAll('.jx-precio'), function (s) { s.textContent = txt; });
    }).catch(function () {});
  }
})();
