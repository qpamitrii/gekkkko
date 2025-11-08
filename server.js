const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище описаний: { fileId: description }
const descriptions = {};
// Хранилище паролей: { fileId: password }
const passwords = {};
// Хранилище счетчиков просмотров: { fileId: { limit: N, current: 0 } }
const viewCounts = {};
const cookieParser = require('cookie-parser');
const sharp = require('sharp');
const crypto = require('crypto');
const fetch = require('node-fetch');
const axios = require('axios');
// Хранилище: fileId → groupFileId (если файл в группе)
const fileToGroup = {};

const { parsePhoneNumberFromString } = require('libphonenumber-js');




// ###################################################
// DataBase - PostgreSQL
const { Pool } = require('pg');

// Создаем пул подключений
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // ← Используем переменную окружения
    ssl: {
        rejectUnauthorized: false // Для Render
    }
});
delete process.env.DATABASE_URL; // ← чтобы не засветить в логах
/*const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    }
});*/
// Запуск сервера — ТОЛЬКО ПОСЛЕ успешной инициализации БД
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS uploads (
                id SERIAL PRIMARY KEY,
                upload_id VARCHAR(36) NOT NULL UNIQUE,  -- ← исправлено: upload_id, не file_id
                phone VARCHAR(50) NOT NULL,
                ip_address VARCHAR(45) NOT NULL,
                description TEXT,
                password VARCHAR(255),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS images (
                id SERIAL PRIMARY KEY,
                image_id VARCHAR(36) NOT NULL UNIQUE,
                upload_id VARCHAR(36) NOT NULL,
                view_limit INTEGER DEFAULT 0,
                view_current INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                FOREIGN KEY (upload_id) REFERENCES uploads(upload_id) ON DELETE CASCADE
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS upload_logs (
                id SERIAL PRIMARY KEY,
                ip_address VARCHAR(45) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('✅ Таблицы uploads, images и upload_logs готовы');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
        throw err; // ← важно: пробрасываем, чтобы .catch сработал
    }
}


initDatabase();



// Экспортируем pool для удобства
module.exports = pool;
//#####################################################



// Создаем папку storage, если её нет
if (!fs.existsSync('storage')) {
    fs.mkdirSync('storage');
}

// Настройка Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'storage/');
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
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
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/img', express.static(path.join(__dirname, 'img')));
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// ✅ Парсинг form-data — ДО маршрутов!
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser()); // ← ✅ для req.cookies

// Главная страница
app.get('/', (req, res) => {
    const csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('XSRF-TOKEN', csrfToken, {
        httpOnly: false,     // ← false, чтобы можно было прочитать в JS на фронтенде
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production'
    });
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Загрузка файла (без капчи)
app.post('/upload', upload.array('image', 20), async (req, res) => {
    const secret = '6LfWndMrAAAAAInmLjVcQecayj4iXFVrnW_0Lait';
    const clientResponse = req.body['g-recaptcha-response'];
    if (!clientResponse) {
        return res.status(400).send('reCAPTCHA required');
    }

    try {
        const verifyRes = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
            params: {
                secret,
                response: clientResponse
            }
        });
        const data = verifyRes.data;
        if (!data.success || data.score < 0.5) {
            return res.status(400).send('reCAPTCHA failed');
        }
    } catch (err) {
        console.error('reCAPTCHA verify error:', err);
        return res.status(500).send('reCAPTCHA verification error');
    }

    
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send('Файлы не выбраны');
        }

        const fileIds = [];

        // ✅ Если файл всего один — игнорируем галочку "Make one post"
        const makeOnePost = req.files.length > 1 && !!req.body.make_one_post;
        const description = req.body.overview || '';

        // ✅ Если makeOnePost — используем ОДИН fileId для всей группы
        const groupFileId = makeOnePost ? uuidv4() : null;

        // ✅ Обрабатываем каждый файл
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            let filePath = file.path;

            if (!fs.existsSync(filePath)) {
                console.error('Файл не найден:', filePath);
                continue; // пропускаем, но можно и остановить — по желанию
            }

            // ✅ Изменение размера — для каждого файла
            if (req.body.resize && req.body.resize_width && req.body.resize_height) {
                const width = parseInt(req.body.resize_width);
                const height = parseInt(req.body.resize_height);

                if (width >= 400 && width <= 3000 && height >= 400 && height <= 3000) {
                    try {
                        const inputBuffer = fs.readFileSync(filePath);
                        let outputFormat = path.extname(file.originalname).toLowerCase().replace('.', '');
                        if (req.body.output_format && ['jpg', 'jpeg', 'png', 'webp'].includes(req.body.output_format)) {
                            outputFormat = req.body.output_format;
                        }

                        let transformer = sharp(inputBuffer).resize(width, height, {
                            kernel: 'cubic',
                            fit: sharp.fit.fill
                        });

                        if (outputFormat === 'jpg' || outputFormat === 'jpeg') {
                            transformer = transformer.jpeg({ quality: 90 });
                        } else if (outputFormat === 'png') {
                            transformer = transformer.png({ compressionLevel: 9 });
                        } else if (outputFormat === 'webp') {
                            transformer = transformer.webp({ quality: 90 });
                        }

                        const outputBuffer = await transformer.toBuffer();
                        const newFileId = uuidv4();
                        const newFileName = `${newFileId}.${outputFormat}`;
                        const newFilePath = path.join(__dirname, 'storage', newFileName);

                        fs.writeFileSync(newFilePath, outputBuffer);
                        fs.unlinkSync(filePath);
                        filePath = newFilePath;

                    } catch (err) {
                        console.error('Ошибка при изменении размера:', err);
                    }
                }
            }

            // ✅ Получаем fileId для этого файла
            const fileId = path.basename(filePath, path.extname(filePath));

            // ✅ Если makeOnePost — используем groupFileId, иначе — fileId файла
            const finalFileId = makeOnePost ? groupFileId : fileId;
            // ✅ Массив для хранения всех fileId (или groupFileId)
            fileIds.push(finalFileId);

            

            // ✅ Сохраняем метаданные — но только один раз для группы
            // ✅ Сохраняем метаданные — один раз для группы, или для каждого файла
            if (!makeOnePost) {
                // Для одиночных файлов — просто описание
                descriptions[fileId] = description;

                // Пароль и автоудаление — на каждый файл отдельно
                if (req.body.allow_password && req.body.password && req.body.password.length >= 6) {
                    passwords[fileId] = req.body.password;
                }

                if (req.body.allow_selfdestruct && req.body.selfdestruct) {
                    const views = parseInt(req.body.selfdestruct);
                    if (views >= 1 && views <= 100) {
                        viewCounts[fileId] = {
                            limit: views,
                            current: 0
                        };
                    }
                }

            } else {
                // Для группы — сохраняем объект { description, files: [...] }
                if (i === 0) {
                    descriptions[groupFileId] = {
                        description: description,
                        files: [] // будем заполнять
                    };

                    // Пароль и автоудаление — привязываем к groupFileId (один на всю группу)
                    if (req.body.allow_password && req.body.password && req.body.password.length >= 6) {
                        passwords[groupFileId] = req.body.password;
                    }
                }

                // Добавляем fileId этого файла в список группы
                if (descriptions[groupFileId] && Array.isArray(descriptions[groupFileId].files)) {
                    descriptions[groupFileId].files.push(fileId);
                    fileToGroup[fileId] = groupFileId;
                }
            }
        }



        // ✅ Получаем IP
        const clientIp = getClientIp(req);

        // ✅ Защита от спама
        const isAllowed = await isUploadAllowed(clientIp);
        if (!isAllowed) {
            return res.status(429).send(`Слишком много загрузок. Попробуйте через 5 минут.`);
        }

        // ✅ Валидация телефона через libphonenumber-js с указанием страны по умолчанию
        const phoneRaw = req.body.user_phone;
        if (!phoneRaw) {
            return res.status(400).send('Телефон обязателен');
        }

        let phoneNormalized = null;
        try {
            // Указываем страну по умолчанию — например, 'RU' для России
            const phoneNumber = parsePhoneNumberFromString(phoneRaw, 'RU');

            if (phoneNumber && phoneNumber.isValid()) {
                phoneNormalized = phoneNumber.format('E.164'); // например: +79091234567
            } else {
                return res.status(400).send('Неверный формат номера телефона');
            }
        } catch (err) {
            return res.status(400).send('Неверный формат номера телефона');
        }


        // После цикла for
        if (fileIds.length === 0) {
            return res.status(500).send('Не удалось обработать ни один файл');
        }
        const mainFileId = fileIds[0]; // ← ЭТО ОБЯЗАТЕЛЬНО!
        const uploadId = makeOnePost ? groupFileId : mainFileId;

        let firstFilePath = null;
        const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

        for (const ext of possibleExtensions) {
            const candidate = path.join(__dirname, 'storage', `${mainFileId}${ext}`);
            if (fs.existsSync(candidate)) {
                firstFilePath = candidate;
                break;
            }
        }

        if (!firstFilePath) {
            return res.status(500).send(`Файл ${mainFileId} не найден в storage.`);
        }
        // Читаем содержимое файла в Buffer
        //const imageBuffer = fs.readFileSync(firstFilePath);

        // ✅ Формируем полную ссылку на изображение
        const host = `${req.protocol}://${req.get('host')}`;
        //const uploadId = `${host}/storage/${mainFileId}${fileExt}`;

        // ✅ Получаем пароль из описаний (если он есть)
        //const password = passwords[mainFileId] || null; // Используйте null, если пароля нет

        // ✅ Сохраняем в БД: сначала запись в uploads
        const uploadSql = `
            INSERT INTO uploads (upload_id, phone, ip_address, description, password)
            VALUES ($1, $2, $3, $4, $5)
        `;
        await pool.query(uploadSql, [
            uploadId,
            phoneNormalized,
            clientIp,
            description,
            passwords[uploadId] || null // Пароль из descriptions[uploadId] или null
        ]);

        // ✅ Затем сохраняем каждое изображение в images
        for (let i = 0; i < fileIds.length; i++) {
            const fileId = fileIds[i];
            let filePath = null;
            const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
            for (const ext of possibleExtensions) {
                const candidate = path.join(__dirname, 'storage', `${fileId}${ext}`);
                if (fs.existsSync(candidate)) {
                    filePath = candidate;
                    break;
                }
            }
            if (!filePath) {
                console.error(`Файл ${fileId} не найден в storage.`);
                continue; // Пропускаем, но можно и остановить — по желанию
            }

            // Читаем содержимое файла в Buffer
            const imageBuffer = fs.readFileSync(filePath);

            // Получаем лимит просмотров (только для одиночных файлов)
            const viewLimit = !makeOnePost && viewCounts[fileId] ? viewCounts[fileId].limit : 0;

            const imageSql = `
                INSERT INTO images (image_id, upload_id, image_data, view_limit, view_current)
                VALUES ($1, $2, $3, $4, $5)
            `;
            await pool.query(imageSql, [fileId, uploadId, imageBuffer, viewLimit, 0]);
        }


        // ✅ Редиректим на первый fileId (или groupFileId)
        res.redirect(`/${uploadId}`);

    } catch (error) {
        res.status(500).send('Ошибка загрузки файла: ' + error.message);
    }
});

async function isUploadAllowed(ip) {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    try {
        const countRes = await pool.query(
            `SELECT COUNT(*) AS count FROM upload_logs WHERE ip_address = $1 AND created_at > $2`,
            [ip, fiveMinutesAgo]
        );
        const count = parseInt(countRes.rows[0].count);
        const MAX_UPLOADS = 10;

        if (count >= MAX_UPLOADS) {
            return false;
        }

        await pool.query(
            'INSERT INTO upload_logs (ip_address) VALUES ($1)',
            [ip]
        );
        return true;
    } catch (err) {
        console.error('Ошибка проверки спама:', err);
        return false; // или false — в зависимости от политики
    }
}

function getClientIp(req) {
    // 1. X-Forwarded-For (если за прокси)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = Array.isArray(forwarded) ? forwarded : forwarded.split(',');
        const ip = ips && ips[0] ? ips[0].trim() : null;
        if (ip && ip !== '127.0.0.1' && !ip.startsWith('::1')) {
            return ip;
        }
    }

    // 2. req.connection.remoteAddress или req.socket.remoteAddress
    let ip = (req.connection && req.connection.remoteAddress) ||
         (req.socket && req.socket.remoteAddress) ||
         '0.0.0.0';

    // 3. Убираем IPv6-обёртку для localhost
    if (ip.startsWith('::ffff:')) {
        ip = ip.substring(7); // остаётся IPv4, например: 127.0.0.1
    } else if (ip === '::1') {
        ip = '127.0.0.1';
    }

    return ip;
}



// Парсер для multipart/form-data без файлов
const parseForm = multer().none();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidFileId(id) {
    return typeof id === 'string' && uuidRegex.test(id);
}

// Маршрут для проверки пароля
app.post('/checkpass', parseForm, (req, res) => {
    const fileId = req.body.fileId;
    if (!isValidFileId(fileId)) {
        return res.status(400).send('Invalid fileId');
    }

    const submittedPassword = req.body.password;
    const returnUrl = req.body.returnUrl || `/${fileId}`;

    if (!fileId || !submittedPassword) {
        return res.status(400).send('Missing fileId or password');
    }

    const correctPassword = passwords[fileId];

    if (submittedPassword === correctPassword) {
        // Пароль верный — ставим куку и редиректим
        const isProd = process.env.NODE_ENV === 'production';
        res.cookie(`pw_${fileId}`, 'true', {
            maxAge: 3600000,
            httpOnly: true,
            secure: isProd,
            sameSite: isProd ? 'Strict' : 'Lax'
        });
        return res.redirect(returnUrl);
    }

    // Пароль неверный — показываем форму с ошибкой
    const host = `${req.protocol}://${req.get('host')}`;
    const pageUrl = `${host}/${fileId}`;

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
            <title>Gecko – Password Protected</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link href="/css/bootstrap.css" rel="stylesheet">
            <link href="/css/font-awesome.min.css" rel="stylesheet">
            <link href="/css/drunken-parrot.css" rel="stylesheet">
            <link href="/css/app.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>

            <div class="row">
                <div class="alert alert-info" role="alert">
                    <div class="container">
                        <div class="alert-icon"><i class="now-ui-icons objects_support-17"></i></div>
                        <span>Пароль введен неверно. Password is not correct.</span>
                        <a href="/">Back to mainpage</a>
                    </div>
                </div>
            </div>

            <div style="margin-bottom: 60px; margin-top: 40px;" class="container">
                <div class="row">
                    <div class="col-sm-6 col-sm-offset-3">
                        <div class="panel panel-success pass-checker-form-panel">
                            <div class="panel-heading">
                                Author protect this link with password
                            </div>
                            <div class="panel-body">
                                <div class="row">
                                    <div class="col-sm-10 col-sm-offset-1">
                                        <form method="POST" action="/checkpass" class="form">
                                            <input type="hidden" name="fileId" value="${fileId}">
                                            <input type="hidden" name="returnUrl" value="${returnUrl}">
                                            <div class="form-group">
                                                <div class="row">
                                                    <label class="control-label" for="password">Password:</label>
                                                    <input class="form-control" name="password" type="password" id="password" required>
                                                </div>
                                            </div>
                                            <div class="form-group">
                                                <div class="row text-center">
                                                    <button type="submit" class="btn btn-success btn-lg btn-embossed">Check</button>
                                                </div>
                                            </div>
                                        </form>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="container">
                <div class="row">
                    <div class="col-sm-4 col-sm-offset-4">
                        <div class="panel panel-info btc-donate-panel">
                            <div class="panel-heading">
                                <h3 class="panel-title">Bitcoin donations are welcome!</h3>
                            </div>
                            <div class="panel-body"><strong>bc1q3p87fqtj84dmcy6u6jyaefjft67qyjh8ccmuc7</strong></div>
                        </div>
                    </div>
                </div>
            </div>

            <footer class="footer footer-default">
                <div class="container">
                    <div class="copyright">
                        © <script>document.write(new Date().getFullYear())</script>, All rights reserved.
                    </div>
                </div>
            </footer>

            <script src="/js/jquery-1.12.4.min.js"></script>
            <script src="/js/bootstrap.min.js"></script>
            <script src="/js/bootstrap-switch.js"></script>
            <script src="/js/checkbox.js"></script>
            <script src="/js/radio.js"></script>
            <script src="/js/toolbar.js"></script>
            <script src="/js/app.js"></script>
        </body>
        </html>
    `;

    res.send(html);
});

// Middleware для проверки пароля
// Middleware для проверки пароля — только проверяет куку
function checkPassword(req, res, next) {
    const fileId = req.params.fileId;
    const correctPassword = passwords[fileId];

    // Если пароля нет — пропускаем
    if (!correctPassword) {
        return next();
    }

    // Если есть валидная кука — пропускаем
    if (req.cookies && req.cookies[`pw_${fileId}`] === 'true') {
        return next();
    }

    // Иначе — показываем форму ввода пароля
    const host = `${req.protocol}://${req.get('host')}`;
    const returnUrl = req.originalUrl;

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
            <title>Gecko – Password Protected</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link href="/css/bootstrap.css" rel="stylesheet">
            <link href="/css/font-awesome.min.css" rel="stylesheet">
            <link href="/css/drunken-parrot.css" rel="stylesheet">
            <link href="/css/app.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>

            <div class="row">
                <div class="alert alert-info" role="alert">
                    <div class="container">
                        <div class="alert-icon"><i class="now-ui-icons objects_support-17"></i></div>
                        <span>Image has downloaded successfully: ${host}${req.originalUrl}</span>
                        <a href="/">Back to mainpage</a>
                    </div>
                </div>
            </div>

            <div style="margin-bottom: 60px; margin-top: 40px;" class="container">
                <div class="row">
                    <div class="col-sm-6 col-sm-offset-3">
                        <div class="panel panel-success pass-checker-form-panel">
                            <div class="panel-heading">
                                Author protect this link with password
                            </div>
                            <div class="panel-body">
                                <div class="row">
                                    <div class="col-sm-10 col-sm-offset-1">
                                        <form method="POST" action="/checkpass" class="form">
                                            <input type="hidden" name="fileId" value="${fileId}">
                                            <input type="hidden" name="returnUrl" value="${returnUrl}">
                                            <div class="form-group">
                                                <div class="row">
                                                    <label class="control-label" for="password">Password:</label>
                                                    <input class="form-control" name="password" type="password" id="password" required>
                                                </div>
                                            </div>
                                            <div class="form-group">
                                                <div class="row text-center">
                                                    <button type="submit" class="btn btn-success btn-lg btn-embossed">Check</button>
                                                </div>
                                            </div>
                                        </form>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="container">
                <div class="row">
                    <div class="col-sm-4 col-sm-offset-4">
                        <div class="panel panel-info btc-donate-panel">
                            <div class="panel-heading">
                                <h3 class="panel-title">Bitcoin donations are welcome!</h3>
                            </div>
                            <div class="panel-body"><strong>bc1q3p87fqtj84dmcy6u6jyaefjft67qyjh8ccmuc7</strong></div>
                        </div>
                    </div>
                </div>
            </div>

            <footer class="footer footer-default">
                <div class="container">
                    <div class="copyright">
                        © <script>document.write(new Date().getFullYear())</script>, All rights reserved.
                    </div>
                </div>
            </footer>

            <script src="/js/jquery-1.12.4.min.js"></script>
            <script src="/js/bootstrap.min.js"></script>
            <script src="/js/bootstrap-switch.js"></script>
            <script src="/js/checkbox.js"></script>
            <script src="/js/radio.js"></script>
            <script src="/js/toolbar.js"></script>
            <script src="/js/app.js"></script>
        </body>
        </html>
    `;

    res.send(html);
}

// Обработка POST-запроса с паролем для /:fileId
app.post('/:fileId', checkPassword, (req, res) => {
    // Если middleware пропустил — значит, пароль верный → редиректим на GET
    res.redirect(`/${req.params.fileId}`);
});

// Обработка POST-запроса с паролем для /i/:fileId
app.post('/i/:fileId', checkPassword, (req, res) => {
    res.redirect(`/i/${req.params.fileId}`);
});


// Страница после загрузки: GET /:fileId
app.get('/:fileId', checkPassword, (req, res) => {
    const fileId = req.params.fileId;
    if (!isValidFileId(fileId)) {
        return res.status(400).send('Invalid file ID');
    }

    const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

    // ✅ Сначала проверим, есть ли этот fileId в описаниях — если нет, возможно, это не группа
    if (!descriptions[fileId]) {
        // Попробуем найти файл как одиночный
        let filePath = null;
        for (const ext of possibleExtensions) {
            const candidate = path.join(__dirname, 'storage', fileId + ext);
            if (fs.existsSync(candidate)) {
                filePath = candidate;
                break;
            }
        }

        if (!filePath) {
            return res.status(404).send('File not found');
        }

        const host = `${req.protocol}://${req.get('host')}`;
        const pageUrl = `${host}/${fileId}`;
        const viewUrl = `${host}/i/${fileId}`;
        const fileExt = path.extname(filePath);
        const directUrlWithExt = `${host}/storage/${fileId}${fileExt}`;
        //const directUrl = `${host}/storage/${fileId}`;

        const description = descriptions[fileId] || '';
        let viewsInfo = ''; // ❌ Views не отображаем

        const safeDescription = escapeHtml(description);

        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
                <title>Gecko – Anonymous Photohosting</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <link href="/css/bootstrap.css" rel="stylesheet">
                <link href="/css/font-awesome.min.css" rel="stylesheet">
                <link href="/css/drunken-parrot.css" rel="stylesheet">
                <link href="/css/app.css" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </head>
            <body>
                <div class="row">
                    <div class="alert alert-info" role="alert">
                        <div class="container">
                            <div class="alert-icon"><i class="now-ui-icons objects_support-17"></i></div>
                            <span>Image has downloaded successfully: ${pageUrl}</span>
                            <a href="/">Back to mainpage</a>
                        </div>
                    </div>
                </div>

                <div class="row">
                    <div class="col-sm-8 col-sm-offset-2">
                        <a target="_blank" href="${viewUrl}">
                            <img style="margin-bottom: 20px; max-width: 100%" src="${directUrlWithExt}">
                        </a>
                    </div>
                </div>

                <div class="adm__img-data-url">
                    <p>URL изображений отдельно:</p>
                    <div class="adm__img-data-url-item">1: <code>${viewUrl}</code></div>
                </div>

                ${description ? `
                <div class="row">
                    <div class="col-sm-8 col-sm-offset-2">
                        <div class="panel-body">
                            <p>${safeDescription}</p>
                        </div>
                    </div>
                </div>
                ` : ''}

                ${viewsInfo}

                <div class="container">
                    <div class="row">
                        <div class="col-sm-4 col-sm-offset-4">
                            <div class="panel panel-info btc-donate-panel">
                                <div class="panel-heading">
                                    <h3 class="panel-title">Bitcoin donations are welcome!</h3>
                                </div>
                                <div class="panel-body"><strong>bc1q3p87fqtj84dmcy6u6jyaefjft67qyjh8ccmuc7</strong></div>
                            </div>
                        </div>
                    </div>
                </div>

                <footer class="footer footer-default">
                    <div class="container">
                        <div class="copyright">
                            © <script>document.write(new Date().getFullYear())</script>, All rights reserved.
                        </div>
                    </div>
                </footer>

                <script src="/js/jquery-1.12.4.min.js"></script>
                <script src="/js/bootstrap.min.js"></script>
                <script src="/js/bootstrap-switch.js"></script>
                <script src="/js/checkbox.js"></script>
                <script src="/js/radio.js"></script>
                <script src="/js/toolbar.js"></script>
                <script src="/js/app.js"></script>
            </body>
            </html>
        `;

        return res.send(html);
    }

    // ✅ Это группа — выводим все файлы, связанные с этим fileId
    const host = `${req.protocol}://${req.get('host')}`;
    const pageUrl = `${host}/${fileId}`;

    const meta = descriptions[fileId];
    let files = [];
    let descriptionText = '';

    if (typeof meta === 'object' && meta.files) {
        files = meta.files;
        descriptionText = meta.description || '';
    } else {
        // Это одиночный файл — уже обработано выше, но на всякий случай:
        files = [fileId];
        descriptionText = meta || '';
    }

    let imagesHtml = '';
    let linksHtml = '';

    for (let i = 0; i < files.length; i++) {
        const fId = files[i];
        let filePath = null;
        for (const ext of possibleExtensions) {
            const candidate = path.join(__dirname, 'storage', fId + ext);
            if (fs.existsSync(candidate)) {
                filePath = candidate;
                break;
            }
        }

        if (!filePath) continue;

        const viewUrl = `${host}/i/${fId}`;
        const fileExt = path.extname(filePath);
        const directUrlWithExt = `${host}/storage/${fId}${fileExt}`;
        //const directUrl = `${host}/storage/${fId}`;

        imagesHtml += `
            <div class="col-sm-6 col-md-4" style="margin-bottom: 20px;">
                <a target="_blank" href="${viewUrl}">
                    <img style="max-width: 100%; height: auto;" src="${directUrlWithExt}">
                </a>
            </div>
        `;

        linksHtml += `
            <div class="adm__img-data-url-item">${i + 1}: <code>${viewUrl}</code></div>
        `;
    }

    let viewsInfo = '';

    // ✅ Выводим Views только если файл НЕ в группе
    if (!fileToGroup[fileId] && viewCounts[fileId]) {
        viewsInfo = `
        <div class="alert alert-warning">
            <strong>Views:</strong> ${viewCounts[fileId].current} / ${viewCounts[fileId].limit}
        </div>
        `;
    }

    const safeDescription = escapeHtml(descriptionText);

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
            <title>Gecko – Anonymous Photohosting</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link href="/css/bootstrap.css" rel="stylesheet">
            <link href="/css/font-awesome.min.css" rel="stylesheet">
            <link href="/css/drunken-parrot.css" rel="stylesheet">
            <link href="/css/app.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>
            <div class="row">
                <div class="alert alert-info" role="alert">
                    <div class="container">
                        <div class="alert-icon"><i class="now-ui-icons objects_support-17"></i></div>
                        <span>Image has downloaded successfully: ${pageUrl}</span>
                        <a href="/">Back to mainpage</a>
                    </div>
                </div>
            </div>

            <div class="row">
                ${imagesHtml}
            </div>

            <div class="adm__img-data-url">
                <p>URL изображений отдельно:</p>
                ${linksHtml}
            </div>

            ${descriptionText ? `
            <div class="row">
                <div class="col-sm-8 col-sm-offset-2">
                    <div class="panel-body">
                        <p>${safeDescription}</p>
                    </div>
                </div>
            </div>
            ` : ''}

            ${viewsInfo}

            <div class="container">
                <div class="row">
                    <div class="col-sm-4 col-sm-offset-4">
                        <div class="panel panel-info btc-donate-panel">
                            <div class="panel-heading">
                                <h3 class="panel-title">Bitcoin donations are welcome!</h3>
                            </div>
                            <div class="panel-body"><strong>bc1q3p87fqtj84dmcy6u6jyaefjft67qyjh8ccmuc7</strong></div>
                        </div>
                    </div>
                </div>
            </div>

            <footer class="footer footer-default">
                <div class="container">
                    <div class="copyright">
                        © <script>document.write(new Date().getFullYear())</script>, All rights reserved.
                    </div>
                </div>
            </footer>

            <script src="/js/jquery-1.12.4.min.js"></script>
            <script src="/js/bootstrap.min.js"></script>
            <script src="/js/bootstrap-switch.js"></script>
            <script src="/js/checkbox.js"></script>
            <script src="/js/radio.js"></script>
            <script src="/js/toolbar.js"></script>
            <script src="/js/app.js"></script>
        </body>
        </html>
    `;

    res.send(html);
});

// Страница просмотра изображения: GET /i/:fileId
app.get('/i/:fileId', checkPassword, (req, res) => {
    const fileId = req.params.fileId;
    if (!isValidFileId(fileId)) {
        return res.status(400).send('Invalid file ID');
    }

    const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    let filePath = null;

    for (const ext of possibleExtensions) {
        const candidate = path.join(__dirname, 'storage', fileId + ext);
        if (fs.existsSync(candidate)) {
            filePath = candidate;
            break;
        }
    }

    if (!filePath) {
        return res.status(404).send('File not found');
    }

    // ✅ Проверяем, принадлежит ли файл к группе (для описания — оставляем)
    // ✅ Проверяем, принадлежит ли файл к группе
    const groupId = fileToGroup[fileId];
    const isGrouped = !!groupId;
    const targetId = isGrouped ? groupId : fileId; // для описания

    // ✅ Увеличиваем счётчик ТОЛЬКО если файл НЕ в группе
    if (!isGrouped && viewCounts[fileId]) {
        viewCounts[fileId].current++;

        // Опционально: если хочешь оставить автоудаление для одиночных файлов
        if (viewCounts[fileId].current > viewCounts[fileId].limit) {
            // Удаляем файл
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                console.error('Ошибка удаления файла:', err);
            }

            // Удаляем метаданные
            delete viewCounts[fileId];
            delete descriptions[fileId];
            delete passwords[fileId];

            return res.redirect('/');
        }
    }

    const host = `${req.protocol}://${req.get('host')}`;
    const fileUrl = `${host}/i/${fileId}`;


    // ✅ Получаем описание: если файл в группе — берём описание группы
    let description = '';
    const meta = descriptions[groupId];
    if (typeof meta === 'object' && meta.description) {
        description = meta.description;
    } else if (typeof meta === 'string') {
        description = meta; // одиночный файл
    }

    const isSingle = !fileToGroup[fileId];
    res.send(generateHtmlPage(fileId, isSingle ? viewCounts[fileId] : null, host, description));
});

// Генерация HTML для /i/:fileId
function generateHtmlPage(fileId, viewCount = null, host, description = '') {
    // ✅ Находим реальное расширение файла на диске
    const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    let fileExt = '';
    for (const ext of possibleExtensions) {
        const candidate = path.join(__dirname, 'storage', fileId + ext);
        if (fs.existsSync(candidate)) {
            fileExt = ext;
            break;
        }
    }

    const directUrlWithExt = `${host}/storage/${fileId}${fileExt}`;
    //const directUrl = `${host}/storage/${fileId}`; // ← Без расширения!

    // ✅ Генерируем информацию о просмотрах — только если viewCount передан (т.е. файл одиночный)
    let viewsInfo = '';
    if (viewCount && typeof viewCount === 'object' && 'current' in viewCount && 'limit' in viewCount) {
        viewsInfo = `
        <div class="alert alert-warning" style="margin-top: 20px;">
            <strong>Views:</strong> ${viewCount.current} / ${viewCount.limit}
            ${viewCount.current >= viewCount.limit ? '<br>⚠️ This image will be deleted after this view!' : ''}
        </div>
        `;
    }

    
    // ✅ Экранируем описание
    const safeDescription = escapeHtml(description);

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
            <title>Image View</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link href="/css/bootstrap.css" rel="stylesheet">
            <link href="/css/font-awesome.min.css" rel="stylesheet">
            <link href="/css/drunken-parrot.css" rel="stylesheet">
            <link href="/css/app.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>
            <div class="app-page app-page-public">
                <div class="wrapper">
                    <div class="row">
                        <div class="text-center col-sm-8 col-sm-offset-2">
                            <img style="margin-bottom: 20px; max-width: 100%;" src="${directUrlWithExt}">
                        </div>
                    </div>

                    ${safeDescription ? `
                        <div class="row">
                            <div class="col-sm-8 col-sm-offset-2">
                                <div class="panel-body">
                                    <p>${safeDescription}</p>
                                </div>
                            </div>
                        </div>
                        ` : ''}

                    <!-- ✅ Выводим информацию о просмотрах -->
                    ${viewsInfo}

                    <div class="container">
                        <div class="row">
                            <div class="col-sm-4 col-sm-offset-4">
                                <div class="panel panel-info btc-donate-panel">
                                    <div class="panel-heading">
                                        <h3 class="panel-title">Bitcoin donations are welcome!</h3>
                                    </div>
                                    <div class="panel-body">
                                        <strong>bc1q3p87fqtj84dmcy6u6jyaefjft67qyjh8ccmuc7</strong>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <footer class="footer footer-default">
                        <div class="container">
                            <div class="copyright">
                                © <script>document.write(new Date().getFullYear())</script>, All rights reserved.
                            </div>
                        </div>
                    </footer>
                </div>
            </div>
            <script src="/js/jquery-1.12.4.min.js"></script>
            <script src="/js/bootstrap.min.js"></script>
            <script src="/js/bootstrap-switch.js"></script>
            <script src="/js/checkbox.js"></script>
            <script src="/js/radio.js"></script>
            <script src="/js/toolbar.js"></script>
            <script src="/js/app.js"></script>
        </body>
        </html>
    `;
}

// Прямая отдача файла: GET /storage/:fileId
app.get('/storage/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    if (!isValidFileId(fileId)) {
        return res.status(400).send('Invalid file ID');
    }

    const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    let filePath = null;

    for (const ext of possibleExtensions) {
        const candidate = path.join(__dirname, 'storage', fileId + ext);
        if (fs.existsSync(candidate)) {
            filePath = candidate;
            break;
        }
    }

    if (!filePath) {
        return res.status(404).send('File not found');
    }

    const mimeType = getMimeType(filePath);
    res.setHeader('Content-Type', mimeType);
    res.sendFile(filePath);
});

// Определение MIME-типа по расширению
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'webp': 'image/webp'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}
//из бд
/*app.get('/storage/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!isValidFileId(fileId)) {
        return res.status(400).send('Invalid file ID');
    }

    try {
        const result = await pool.query('SELECT image_data FROM uploads WHERE file_id = $1', [fileId]);
        if (result.rows.length === 0) {
            return res.status(404).send('File not found');
        }

        const buffer = result.rows[0].image_data;

        // Определяем MIME-тип по сигнатурам (magic bytes)
        const mimeType = getMimeTypeFromBuffer(buffer); // см. функцию ниже

        res.setHeader('Content-Type', mimeType);
        res.send(buffer);
    } catch (err) {
        console.error('Ошибка чтения из БД:', err);
        res.status(500).send('Server error');
    }
});

// Функция определения MIME по байтам
function getMimeTypeFromBuffer(buf) {
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'application/octet-stream';
}*/



// Функция для экранирования HTML
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '<',
        '>': '>',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// Обработка ошибок Multer
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " + // ← 'unsafe-inline' нужен из-за <script> в HTML, но лучше убрать и вынести скрипты
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
        "img-src 'self' data:; " +
        "font-src 'self' https://cdnjs.cloudflare.com; " +
        "frame-ancestors 'none'; " +
        "object-src 'none';"
    );
    next();
});


process.on('uncaughtException', (err) => {
    console.error('Unhandled Exception:', err);
    process.exit(1);
});