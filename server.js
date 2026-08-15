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

// Database initialization
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrate columns for existing databases
  db.run(`ALTER TABLE posts ADD COLUMN likes INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE posts ADD COLUMN views INTEGER DEFAULT 0`, () => {});

  // Nested Comments table
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

// Anti-Spam Middleware
const validateComment = (req, res, next) => {
  const { author, content, website } = req.body;

  // 1. Honeypot check (hidden field filled by bots)
  if (website) {
    return res.status(400).json({ error: 'Spam submission detected.' });
  }

  // 2. Length check
  if (!author || !content || author.trim().length < 2 || content.trim().length < 3) {
    return res.status(400).json({ error: 'Comment content or author name is too short.' });
  }

  // 3. Keyword / Link filter
  const spamKeywords = ['http://', 'https://', 'buy cheap', 'casino', 'crypto loan', 'free money'];
  const hasSpam = spamKeywords.some(keyword => content.toLowerCase().includes(keyword));
  if (hasSpam) {
    return res.status(400).json({ error: 'Links and promotional keywords are not allowed.' });
  }

  next();
};

// --- Routes ---

// Get all posts
app.get('/api/posts', (req, res) => {
  db.all('SELECT * FROM posts ORDER BY createdAt DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get single post & increment view count automatically
app.get('/api/posts/:id', (req, res) => {
  db.run('UPDATE posts SET views = views + 1 WHERE id = ?', [req.params.id]);
  
  db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    res.json(row);
  });
});

// Upvote / Like post
app.post('/api/posts/:id/like', (req, res) => {
  db.run('UPDATE posts SET likes = likes + 1 WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT likes FROM posts WHERE id = ?', [req.params.id], (err, row) => {
      res.json({ likes: row ? row.likes : 0 });
    });
  });
});

// Get comments for a post
app.get('/api/posts/:id/comments', (req, res) => {
  db.all('SELECT * FROM comments WHERE post_id = ? ORDER BY createdAt ASC', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add comment with anti-spam
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
  const { title, author, content } = req.body;
  if (!title || !author || !content) return res.status(400).json({ error: 'All fields are required.' });

  db.run('INSERT INTO posts (title, author, content) VALUES (?, ?, ?)', [title, author, content], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, title, author, content });
  });
});

app.put('/api/posts/:id', requireAuth, (req, res) => {
  const { title, author, content } = req.body;
  if (!title || !author || !content) return res.status(400).json({ error: 'All fields are required.' });

  db.run('UPDATE posts SET title = ?, author = ?, content = ? WHERE id = ?', [title, author, content, req.params.id], function (err) {
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