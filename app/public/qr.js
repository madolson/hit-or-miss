// Valkey-branded QR code, the hexagon mode of https://madelynolson.com/qr-generator.
function drawQR(canvas, url, size) {
  var qr;
  for (var t = 1; t <= 40; t++) {
    try { qr = qrcode(t, 'H'); qr.addData(url); qr.make(); break; } catch (e) { qr = null; }
  }
  var ctx = canvas.getContext('2d');
  var count = qr.getModuleCount();
  var quiet = 4;
  var total = count + quiet * 2;
  var mod = Math.floor(size / total);
  var px = mod * total;
  canvas.width = canvas.height = px;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (var r = 0; r < count; r++) {
    for (var c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * mod, (r + quiet) * mod, mod, mod);
    }
  }
  var center = px / 2;
  var logoRadius = (total * 0.3) / 2 * mod;
  var maskRadius = logoRadius * 1.1;
  ctx.beginPath();
  for (var i = 0; i < 6; i++) {
    var a = Math.PI / 180 * (60 * i - 30);
    var x = center + maskRadius * Math.cos(a), y = center + maskRadius * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  var logo = new Image();
  logo.onload = function () {
    var h = logoRadius * 2, w = h * (201.7 / 232.87);
    ctx.drawImage(logo, center - w / 2, center - h / 2, w, h);
  };
  logo.src = '/valkey-logo.svg';
}
