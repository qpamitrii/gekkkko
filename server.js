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
// Хранилище: fileId → groupFileId (если файл в группе)
const fileToGroup = {};

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
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Загрузка файла (без капчи)
app.post('/upload', upload.array('image', 20), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send('Файлы не выбраны');
        }

        // ✅ Если файл всего один — игнорируем галочку "Make one post"
        const makeOnePost = req.files.length > 1 && !!req.body.make_one_post;
        const description = req.body.overview || '';

        // ✅ Если makeOnePost — используем ОДИН fileId для всей группы
        const groupFileId = makeOnePost ? uuidv4() : null;

        // ✅ Массив для хранения всех fileId (или groupFileId)
        const fileIds = [];

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

        // ✅ Редиректим на первый fileId (или groupFileId)
        res.redirect(`/${fileIds[0]}`);

    } catch (error) {
        res.status(500).send('Ошибка загрузки файла: ' + error.message);
    }
});

// Парсер для multipart/form-data без файлов
const parseForm = multer().none();

// Маршрут для проверки пароля
app.post('/checkpass', parseForm, (req, res) => {
    const fileId = req.body.fileId;
    const submittedPassword = req.body.password;
    const returnUrl = req.body.returnUrl || `/${fileId}`;

    if (!fileId || !submittedPassword) {
        return res.status(400).send('Missing fileId or password');
    }

    const correctPassword = passwords[fileId];

    if (submittedPassword === correctPassword) {
        // Пароль верный — ставим куку и редиректим
        res.cookie(`pw_${fileId}`, 'true', { maxAge: 3600000, httpOnly: true });
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
        const directUrl = `${host}/storage/${fId}${fileExt}`;

        imagesHtml += `
            <div class="col-sm-6 col-md-4" style="margin-bottom: 20px;">
                <a target="_blank" href="${viewUrl}">
                    <img style="max-width: 100%; height: auto;" src="${directUrl}">
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
// Страница просмотра изображения: GET /i/:fileId
app.get('/i/:fileId', checkPassword, (req, res) => {
    const fileId = req.params.fileId;
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

    res.setHeader('Content-Type', mimeType);
    res.sendFile(filePath);

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
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).send('File too large (max 10MB)');
        }
    }
    res.status(500).send('Error: ' + error.message);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});