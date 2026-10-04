// Valkey-branded QR code, the voxel hexagon mode of https://madelynolson.com/qr-generator:
// modules that touch the hexagon are left out, so the cutout follows the grid.
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

  // Logo 30% of the width, mask 10% larger, both in module units from the center.
  var centerMod = total / 2;
  var logoModRadius = (total * 0.3) / 2;
  var maskModRadius = logoModRadius * 1.1;
  var hex = [];
  for (var i = 0; i < 6; i++) {
    var a = Math.PI / 180 * (60 * i - 30);
    hex.push([maskModRadius * Math.cos(a), maskModRadius * Math.sin(a)]);
  }
  function inHex(x, y) {
    for (var i = 0; i < 6; i++) {
      var j = (i + 1) % 6;
      if ((hex[j][0] - hex[i][0]) * (y - hex[i][1]) - (hex[j][1] - hex[i][1]) * (x - hex[i][0]) < 0) return false;
    }
    return true;
  }
  function occluded(r, c) {
    var left = c + quiet - centerMod, right = left + 1;
    var top = r + quiet - centerMod, bottom = top + 1;
    return inHex(left, top) || inHex(right, top) || inHex(left, bottom) || inHex(right, bottom);
  }

  ctx.fillStyle = '#000';
  for (var r = 0; r < count; r++) {
    for (var c = 0; c < count; c++) {
      if (qr.isDark(r, c) && !occluded(r, c)) ctx.fillRect((c + quiet) * mod, (r + quiet) * mod, mod, mod);
    }
  }

  var center = px / 2;
  var logo = new Image();
  logo.onload = function () {
    var h = logoModRadius * 2 * mod, w = h * (201.7 / 232.87);
    ctx.drawImage(logo, center - w / 2, center - h / 2, w, h);
  };
  logo.src = '/valkey-logo.svg';
}
