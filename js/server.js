const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Создаем папки если их нет
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
}

// Настройка Multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB лимит
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|bmp|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Разрешены только изображения'));
        }
    }
});

// Middleware
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.urlencoded({ extended: true }));

// Маршруты  app.get('/') - отдает главную страницу (index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Загрузка файла - ТЕПЕРЬ С РЕДИРЕКТОМ
app.post('/upload', upload.single('image'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('Файл не выбран');
        }

        // Редирект на страницу просмотра
        res.redirect(`/view/${req.file.filename}`);
    } catch (error) {
        res.status(500).send('Ошибка загрузки файла: ' + error.message);
    }
});

// Страница просмотра загруженного изображения
app.get('/view/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Image Uploaded Successfully</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        margin: 0; 
                        padding: 20px; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                    }
                    .container { 
                        background: white; 
                        padding: 30px; 
                        border-radius: 15px; 
                        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                        max-width: 800px;
                        width: 100%;
                        text-align: center;
                    }
                    h1 {
                        color: #333;
                        margin-bottom: 20px;
                    }
                    .image-container {
                        margin: 20px 0;
                    }
                    img { 
                        max-width: 100%; 
                        max-height: 500px;
                        border-radius: 10px;
                        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                    }
                    .url-box {
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 8px;
                        margin: 20px 0;
                        border-left: 4px solid #667eea;
                    }
                    .url-box input {
                        width: 100%;
                        padding: 10px;
                        border: 1px solid #ddd;
                        border-radius: 5px;
                        font-size: 14px;
                        margin-bottom: 10px;
                    }
                    .btn {
                        display: inline-block;
                        padding: 12px 25px;
                        margin: 5px;
                        background: #667eea;
                        color: white;
                        text-decoration: none;
                        border-radius: 25px;
                        border: none;
                        cursor: pointer;
                        transition: background 0.3s;
                    }
                    .btn:hover {
                        background: #5a67d8;
                    }
                    .btn-success {
                        background: #28a745;
                    }
                    .btn-success:hover {
                        background: #218838;
                    }
                    .info {
                        color: #666;
                        margin: 10px 0;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Image Uploaded Successfully!</h1>
                    
                    <div class="image-container">
                        <img src="/uploads/${filename}" alt="Uploaded image">
                    </div>
                    
                    <div class="url-box">
                        <h3>Your Image URL:</h3>
                        <input type="text" value="${fileUrl}" id="imageUrl" readonly>
                        <button class="btn" onclick="copyUrl()">Copy URL</button>
                    </div>
                    
                    <div class="info">
                        <p><strong>Filename:</strong> ${filename}</p>
                        <p><strong>Size:</strong> ${(stats.size / 1024).toFixed(2)} KB</p>
                        <p><strong>Uploaded:</strong> ${new Date().toLocaleString()}</p>
                    </div>
                    
                    <div>
                        <a href="/" class="btn">Upload Another Image</a>
                        <a href="/download/${filename}" class="btn btn-success">Download Image</a>
                    </div>
                </div>

                <script>
                    function copyUrl() {
                        const input = document.getElementById('imageUrl');
                        input.select();
                        document.execCommand('copy');
                        alert('URL copied to clipboard!');
                    }
                </script>
            </body>
            </html>
        `);
    } else {
        res.status(404).send('File not found');
    }
});

// Скачивание файла  позволяет скачать файл
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'Файл не найден' });
    }
});

// Обработка ошибок Multer    app.use('/uploads') - делает папку uploads доступной для прямых запросов
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).send('File too large (max 10MB)');
        }
    }
    res.status(500).send('Error: ' + error.message);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});