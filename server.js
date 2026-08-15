const { createRequire } = require('module');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// sql.js is the real SQLite engine compiled to WebAssembly - no native
// binaries, so it works on Vercel serverless (no glibc / bundler issues).
const localRequire = createRequire(__filename);
const initSqlJs = () =>
  localRequire('sql.js')({
    locateFile: (file) =>
      path.join(path.dirname(localRequire.resolve('sql.js')), file),
  });

// SQLite needs a writable location. Vercel serverless functions only allow
// writes under /tmp (and it is ephemeral - resets on cold start).
const DB_PATH = process.env.VERCEL
  ? '/tmp/blog.db'
  : path.join(__dirname, 'blog.db');

let db = null;

const ready = initSqlJs()
  .then((SQL) => {
    db = fs.existsSync(DB_PATH)
      ? new SQL.Database(fs.readFileSync(DB_PATH))
      : new SQL.Database();

    db.run(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    throw err;
  });

// Wait for the database before handling any request.
app.use((req, res, next) => ready.then(() => next()).catch(next));

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0];
}

function run(sql, params = []) {
  db.run(sql, params);
  const info = get('SELECT last_insert_rowid() AS id, changes() AS changes');
  persist();
  return { lastID: info.id, changes: info.changes };
}

function persist() {
  try {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  } catch (err) {
    console.error('Failed to persist database:', err.message);
  }
}

// Auth Middleware Simulation
const requireAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (authHeader === 'Bearer secret-admin-token') {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Admin token required.' });
  }
};

// --- API Routes ---

// Get all posts
app.get('/api/posts', (req, res) => {
  try {
    res.json(all('SELECT * FROM posts ORDER BY createdAt DESC'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single post
app.get('/api/posts/:id', (req, res) => {
  try {
    const post = get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create post (Protected)
app.post('/api/posts', requireAuth, (req, res) => {
  const { title, author, content } = req.body;
  if (!title || !author || !content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const info = run('INSERT INTO posts (title, author, content) VALUES (?, ?, ?)', [title, author, content]);
    res.status(201).json({ id: info.lastID, title, author, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update post (Protected)
app.put('/api/posts/:id', requireAuth, (req, res) => {
  const { title, author, content } = req.body;
  if (!title || !author || !content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const info = run('UPDATE posts SET title = ?, author = ?, content = ? WHERE id = ?', [title, author, content, req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ message: 'Post updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete post (Protected)
app.delete('/api/posts/:id', requireAuth, (req, res) => {
  try {
    const info = run('DELETE FROM posts WHERE id = ?', [req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ message: 'Post deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start the server only when run directly (`node server.js`).
// On Vercel the app is imported and invoked as a serverless function.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
