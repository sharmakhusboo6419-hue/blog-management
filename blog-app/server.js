const { createRequire } = require('module');
const express = require('express');
const path = require('path');

// Load sqlite3 via createRequire so Vercel's bundler leaves the native
// module external. Bundling sqlite3 breaks its runtime exports
// (TypeError: ...default.verbose is not a function).
const localRequire = createRequire(__filename);
const sqlite3 = localRequire('sqlite3').verbose();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite needs a writable location. Vercel serverless functions only allow
// writes under /tmp (and it is ephemeral - resets on cold start).
const DB_PATH = process.env.VERCEL
  ? '/tmp/blog.db'
  : path.join(__dirname, 'blog.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log(`Connected to SQLite database (${DB_PATH}).`);
});

db.run(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const requireAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (authHeader === 'Bearer secret-admin-token') {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Admin token required.' });
  }
};

app.get('/api/posts', (req, res) => {
  db.all('SELECT * FROM posts ORDER BY createdAt DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/posts/:id', (req, res) => {
  db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    res.json(row);
  });
});

app.post('/api/posts', requireAuth, (req, res) => {
  const { title, author, content } = req.body;
  if (!title || !author || !content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  db.run('INSERT INTO posts (title, author, content) VALUES (?, ?, ?)', [title, author, content], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, title, author, content });
  });
});

app.put('/api/posts/:id', requireAuth, (req, res) => {
  const { title, author, content } = req.body;
  if (!title || !author || !content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  db.run('UPDATE posts SET title = ?, author = ?, content = ? WHERE id = ?', [title, author, content, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ message: 'Post updated successfully.' });
  });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM posts WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ message: 'Post deleted successfully.' });
  });
});

// Start the server only when run directly (`node server.js`).
// On Vercel the app is imported and invoked as a serverless function.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;