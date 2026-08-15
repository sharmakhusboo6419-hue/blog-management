const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./blog.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite database.');
});

// Database schema initialization
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '',
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrate columns for existing databases
  db.run(`ALTER TABLE posts ADD COLUMN likes INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE posts ADD COLUMN views INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE posts ADD COLUMN tags TEXT DEFAULT ''`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  )`);
});

const requireAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (authHeader === 'Bearer secret-admin-token') {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Admin token required.' });
  }
};

const validateComment = (req, res, next) => {
  const { author, content, website } = req.body;
  if (website) return res.status(400).json({ error: 'Spam submission detected.' });
  if (!author || !content || author.trim().length < 2 || content.trim().length < 3) {
    return res.status(400).json({ error: 'Comment content or author name is too short.' });
  }
  const spamKeywords = ['http://', 'https://', 'buy cheap', 'casino', 'crypto loan', 'free money'];
  if (spamKeywords.some(keyword => content.toLowerCase().includes(keyword))) {
    return res.status(400).json({ error: 'Links and promotional keywords are not allowed.' });
  }
  next();
};

// --- API Routes ---

// Get posts with live search and tag filtering
app.get('/api/posts', (req, res) => {
  const { search, tag } = req.query;
  let query = 'SELECT * FROM posts';
  const params = [];
  const conditions = [];

  if (search && search.trim() !== '') {
    conditions.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }

  if (tag && tag.trim() !== '') {
    conditions.push('tags LIKE ?');
    params.push(`%${tag.trim().replace(/^#/, '')}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY createdAt DESC';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/posts/:id', (req, res) => {
  db.run('UPDATE posts SET views = views + 1 WHERE id = ?', [req.params.id]);
  db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    res.json(row);
  });
});

app.post('/api/posts/:id/like', (req, res) => {
  db.run('UPDATE posts SET likes = likes + 1 WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT likes FROM posts WHERE id = ?', [req.params.id], (err, row) => {
      res.json({ likes: row ? row.likes : 0 });
    });
  });
});

app.get('/api/posts/:id/comments', (req, res) => {
  db.all('SELECT * FROM comments WHERE post_id = ? ORDER BY createdAt ASC', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/posts/:id/comments', validateComment, (req, res) => {
  const { author, content, parent_id } = req.body;
  const parentId = parent_id ? parseInt(parent_id) : null;

  db.run(
    'INSERT INTO comments (post_id, parent_id, author, content) VALUES (?, ?, ?, ?)',
    [req.params.id, parentId, author.trim(), content.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID, post_id: req.params.id, parent_id: parentId, author, content, createdAt: new Date() });
    }
  );
});

// Admin Post Management
app.post('/api/posts', requireAuth, (req, res) => {
  const { title, author, content, tags } = req.body;
  if (!title || !author || !content) return res.status(400).json({ error: 'All fields are required.' });

  const cleanTags = (tags || '')
    .split(',')
    .map(t => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .join(',');

  db.run('INSERT INTO posts (title, author, content, tags) VALUES (?, ?, ?, ?)', [title, author, content, cleanTags], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, title, author, content, tags: cleanTags });
  });
});

app.put('/api/posts/:id', requireAuth, (req, res) => {
  const { title, author, content, tags } = req.body;
  if (!title || !author || !content) return res.status(400).json({ error: 'All fields are required.' });

  const cleanTags = (tags || '')
    .split(',')
    .map(t => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .join(',');

  db.run('UPDATE posts SET title = ?, author = ?, content = ?, tags = ? WHERE id = ?', [title, author, content, cleanTags, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Post updated successfully.' });
  });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM posts WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Post deleted successfully.' });
  });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));