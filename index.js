// index.js — versión optimizada y lista para el diseño PlayStation Store

const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./db');
const PDFDocument = require('pdfkit');

const app = express();

// -------------------------
// CONFIGURACIÓN
// -------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// -------------------------
// SESIONES
// -------------------------
app.use(
  session({
    secret: 'mi_clave_super_secreta_para_el_carrito_psx',
    resave: false,
    saveUninitialized: true,
  })
);

// Crear carrito si no existe
app.use((req, res, next) => {
  if (!req.session.cart) req.session.cart = [];
  next();
});

// Variables globales para las vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.cartCount = req.session.cart.reduce((sum, item) => sum + item.cantidad, 0);
  next();
});

// -------------------------
// FUNCIONES
// -------------------------
function calcularTotal(cart) {
  return cart.reduce((sum, item) => sum + item.precio * item.cantidad, 0);
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/productos?loginError=Debes iniciar sesión.');
  next();
}

// -------------------------
// RUTAS PRINCIPALES
// -------------------------
app.get('/', (req, res) => res.redirect('/productos'));

// -------------------------
// PRODUCTOS
// -------------------------
app.get('/productos', (req, res) => {
  const { loginError, registroError } = req.query;

  db.query('SELECT * FROM productos', (err, results) => {
    if (err) return res.status(500).send('Error al obtener productos');

    res.render('productos', {
      productos: results,
      loginError,
      registroError,
    });
  });
});

// -------------------------
// CARRITO
// -------------------------
app.post('/carrito/agregar', (req, res) => {
  const { productoId } = req.body;

  db.query('SELECT * FROM productos WHERE id = ?', [productoId], (err, results) => {
    if (err || !results.length) return res.redirect('/productos');

    const producto = results[0];
    const cart = req.session.cart;
    const existing = cart.find((i) => i.producto_id === producto.id);

    existing ? (existing.cantidad += 1) : cart.push({
      producto_id: producto.id,
      nombre: producto.nombre,
      precio: Number(producto.precio),
      cantidad: 1,
    });

    res.redirect('/productos');
  });
});

app.get('/carrito', (req, res) => {
  const cart = req.session.cart;
  const total = calcularTotal(cart);
  res.render('carrito', { cart, total });
});

app.post('/carrito/actualizar', (req, res) => {
  const { productoId, cantidad } = req.body;

  const cart = req.session.cart;
  const item = cart.find((i) => i.producto_id == productoId);

  if (item && cantidad >= 1) item.cantidad = parseInt(cantidad);

  res.redirect('/carrito');
});

app.post('/carrito/eliminar', (req, res) => {
  req.session.cart = req.session.cart.filter((i) => i.producto_id != req.body.productoId);
  res.redirect('/carrito');
});

// -------------------------
// AUTENTICACIÓN
// -------------------------
app.post('/registro', (req, res) => {
  const { nombre, email, password } = req.body;

  if (!nombre || !email || !password)
    return res.redirect('/productos?registroError=Completa todos los campos.');

  db.query('SELECT * FROM usuarios WHERE email = ?', [email], (err, results) => {
    if (err) return res.redirect('/productos?registroError=Error en el servidor.');

    if (results.length)
      return res.redirect('/productos?registroError=El correo ya está registrado.');

    db.query(
      'INSERT INTO usuarios (nombre, email, password) VALUES (?, ?, ?)',
      [nombre, email, password],
      (err2, result) => {
        if (err2) return res.redirect('/productos?registroError=No se pudo registrar.');

        req.session.user = { id: result.insertId, nombre, email };
        res.redirect('/productos');
      }
    );
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;

  db.query('SELECT * FROM usuarios WHERE email = ?', [email], (err, results) => {
    if (err || !results.length) return res.redirect('/productos?loginError=Datos incorrectos.');

    const user = results[0];

    if (user.password !== password)
      return res.redirect('/productos?loginError=Datos incorrectos.');

    req.session.user = { id: user.id, nombre: user.nombre, email: user.email };

    res.redirect('/productos');
  });
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/productos')));

// -------------------------
// CHECKOUT & TICKETS
// -------------------------
app.get('/checkout', requireLogin, (req, res) => {
  const cart = req.session.cart;
  if (!cart.length) return res.redirect('/carrito');

  res.render('checkout', { cart, total: calcularTotal(cart) });
});

app.post('/checkout', requireLogin, (req, res) => {
  const cart = req.session.cart;
  const userId = req.session.user.id;
  const total = calcularTotal(cart);

  db.query(
    'INSERT INTO ordenes (usuario_id, total) VALUES (?, ?)',
    [userId, total],
    (err, result) => {
      if (err) return res.status(500).send('Error al crear la orden.');

      const ordenId = result.insertId;

      cart.forEach((item) => {
        db.query(
          `INSERT INTO orden_detalle (orden_id, producto_id, cantidad, precio_unitario, subtotal)
           VALUES (?, ?, ?, ?, ?)`,
          [ordenId, item.producto_id, item.cantidad, item.precio, item.precio * item.cantidad]
        );
      });

      req.session.cart = [];
      res.redirect('/historial?ordenExitosa=1');
    }
  );
});

// -------------------------
// HISTORIAL
// -------------------------
app.get('/historial', requireLogin, (req, res) => {
  const userId = req.session.user.id;

  db.query(
    `SELECT id, total, fecha_orden 
     FROM ordenes 
     WHERE usuario_id = ? 
     ORDER BY fecha_orden DESC`,
    [userId],
    (err, ordenes) => {
      if (err) return res.status(500).send('Error al obtener historial.');

      if (!ordenes.length)
        return res.render('historial', { ordenes: [], detallesPorOrden: {}, ordenExitosa: req.query.ordenExitosa });

      const ids = ordenes.map((o) => o.id);

      db.query(
        `SELECT od.*, p.nombre AS producto_nombre
         FROM orden_detalle od
         JOIN productos p ON p.id = od.producto_id
         WHERE od.orden_id IN (?)`,
        [ids],
        (err2, detalles) => {
          if (err2) return res.status(500).send('Error al obtener historial.');

          const detallesPorOrden = {};
          detalles.forEach((d) => {
            if (!detallesPorOrden[d.orden_id]) detallesPorOrden[d.orden_id] = [];
            detallesPorOrden[d.orden_id].push(d);
          });

          res.render('historial', {
            ordenes,
            detallesPorOrden,
            ordenExitosa: req.query.ordenExitosa,
          });
        }
      );
    }
  );
});

// -------------------------
// TICKET PDF
// -------------------------
app.get('/ticket/:ordenId', requireLogin, (req, res) => {
  const ordenId = req.params.ordenId;
  const userId = req.session.user.id;

  db.query(
    `SELECT * FROM ordenes WHERE id = ? AND usuario_id = ?`,
    [ordenId, userId],
    (err, ordenes) => {
      if (err || !ordenes.length)
        return res.status(404).send('Orden no encontrada.');

      const orden = ordenes[0];

      db.query(
        `SELECT od.*, p.nombre AS producto_nombre
         FROM orden_detalle od
         JOIN productos p ON p.id = od.producto_id
         WHERE od.orden_id = ?`,
        [ordenId],
        (err2, detalles) => {
          if (err2) return res.status(500).send('Error al generar ticket.');

          const doc = new PDFDocument({ margin: 50 });

          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="ticket_${ordenId}.pdf"`);

          doc.pipe(res);

          doc.fontSize(20).text('PlayStation Geek Store', { align: 'center' });
          doc.moveDown();
          doc.fontSize(14).text(`Ticket de compra • Orden #${orden.id}\n`);
          doc.text(`Cliente: ${req.session.user.nombre}`);
          doc.text(`Correo: ${req.session.user.email}`);
          doc.text(`Fecha: ${orden.fecha_orden}`);
          doc.moveDown();

          doc.text('Productos:', { underline: true });
          doc.moveDown(0.5);

          detalles.forEach((d) => {
            doc.text(
              `${d.producto_nombre}  | Cant: ${d.cantidad}  | $${d.precio_unitario} c/u  | Subtotal: $${d.subtotal}`
            );
          });

          doc.moveDown();
          doc.fontSize(16).text(`Total: $${orden.total}`, { align: 'right' });

          doc.end();
        }
      );
    }
  );
});

// -------------------------
// SERVIDOR
// -------------------------
app.listen(3000, () =>
  console.log('Servidor PlayStation Store en http://localhost:3000')
);
