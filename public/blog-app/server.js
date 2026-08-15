const { createRequire } = require('module');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// sql.js is the real SQLite engine compiled to WebAssembly - no native
// binaries, so it works on Vercel serverless (no glibc / bundler issues).
// The .wasm binary is embedded (base64) directly in this bundle so the
// bundler ships it inside the function instead of dropping the asset.
const localRequire = createRequire(__filename);
const wasmBinary = Buffer.from(require('./wasm-binary.js'), 'base64');
const initSqlJs = () => localRequire('sql.js')({ wasmBinary });

// SQLite needs a writable location. Vercel serverless functions only allow
// writes under /tmp (and it is ephemeral - resets on cold start).
const DB_PATH = process.env.VERCEL
  ? '/tmp/blog.db'
  : path.join(__dirname, 'blog.db');

let db = null;
let initError = null;

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

    // These additions preserve databases created by earlier versions while
    // supporting the article metadata exposed by the client.
    const columns = all('PRAGMA table_info(posts)').map((column) => column.name);
    if (!columns.includes('tags')) db.run("ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
    if (!columns.includes('likes')) db.run('ALTER TABLE posts ADD COLUMN likes INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('views')) db.run('ALTER TABLE posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0');
    db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      parent_id INTEGER,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // A first-run reading shelf keeps the publication view useful before an
    // editor has added their own posts. Existing databases are never changed.
    if (get('SELECT COUNT(*) AS count FROM posts').count === 0) {
      db.run(`INSERT INTO posts (title, author, content, tags, likes, views) VALUES
        ('Designing interfaces that invite a second look', 'Maya Chen', 'A thoughtful interface makes its purpose clear before it asks for attention. Here are a few ways we use rhythm, contrast, and restraint to make everyday product moments feel considered.', 'design,frontend,ux', 18, 142),
        ('The small rituals behind dependable Node services', 'Arun Patel', 'Reliable services are built from small habits: useful logs, explicit failure paths, and migrations that respect the data already in the room. This is a practical tour of the routines that keep a Node application calm.', 'nodejs,backend,reliability', 27, 204),
        ('A field guide to shipping the quiet details', 'Nia Foster', 'The details users remember are often the ones they never consciously notice. We collected a short field guide to focus states, empty states, and the moments between loading and done.', 'webdev,accessibility,product', 11, 96)`);
    }
    persist();
  })
  .catch((err) => {
    initError = err;
    console.error('Failed to initialize database:', err.message);
  });

// Wait for the database before handling any request. On failure, return a
// JSON error instead of crashing the process (avoids unhandled rejection).
app.use((req, res, next) =>
  ready.then(() => {
    if (initError) return res.status(503).json({ error: 'Database failed to initialize.' });
    next();
  })
);

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
    const search = (req.query.search || '').trim();
    const tag = (req.query.tag || '').trim();
    const clauses = [];
    const params = [];
    if (search) {
      clauses.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    if (tag) {
      clauses.push("(',' || lower(tags) || ',') LIKE ?");
      params.push(`%,${tag.toLowerCase()},%`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    res.json(all(`SELECT * FROM posts${where} ORDER BY createdAt DESC`, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single post
app.get('/api/posts/:id', (req, res) => {
  try {
    const found = get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    if (!found) return res.status(404).json({ error: 'Post not found.' });
    run('UPDATE posts SET views = views + 1 WHERE id = ?', [req.params.id]);
    const post = get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create post (Protected)
app.post('/api/posts', requireAuth, (req, res) => {
  const { title, author, content, tags = '' } = req.body;
  if (!title || !author || !content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const info = run('INSERT INTO posts (title, author, content, tags) VALUES (?, ?, ?, ?)', [title, author, content, tags]);
    res.status(201).json({ id: info.lastID, title, author, content, tags, likes: 0, views: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update post (Protected)
app.put('/api/posts/:id', requireAuth, (req, res) => {
  const { title, author, content, tags = '' } = req.body;
  if (!title || !author || !content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const info = run('UPDATE posts SET title = ?, author = ?, content = ?, tags = ? WHERE id = ?', [title, author, content, tags, req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ message: 'Post updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/like', (req, res) => {
  try {
    const info = run('UPDATE posts SET likes = likes + 1 WHERE id = ?', [req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ likes: get('SELECT likes FROM posts WHERE id = ?', [req.params.id]).likes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/:id/comments', (req, res) => {
  try {
    res.json(all('SELECT * FROM comments WHERE post_id = ? ORDER BY createdAt ASC, id ASC', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/comments', (req, res) => {
  const { author, content, parent_id, website } = req.body;
  if (website) return res.status(400).json({ error: 'Spam submission rejected.' });
  if (!author || !content) return res.status(400).json({ error: 'Name and comment are required.' });
  if (/https?:\/\//i.test(content)) return res.status(400).json({ error: 'Links are not allowed in comments.' });
  try {
    if (!get('SELECT id FROM posts WHERE id = ?', [req.params.id])) return res.status(404).json({ error: 'Post not found.' });
    const parent = parent_id ? get('SELECT id FROM comments WHERE id = ? AND post_id = ?', [parent_id, req.params.id]) : null;
    if (parent_id && !parent) return res.status(400).json({ error: 'Reply target was not found.' });
    const info = run('INSERT INTO comments (post_id, parent_id, author, content) VALUES (?, ?, ?, ?)', [req.params.id, parent_id || null, author, content]);
    res.status(201).json(get('SELECT * FROM comments WHERE id = ?', [info.lastID]));
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
