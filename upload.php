<?php
// upload.php - обработчик загрузки файлов

// Включение вывода ошибок (только для разработки)
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

session_start();

// Проверка, что запрос отправлен методом POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405); // Method Not Allowed
    echo "Invalid request method.";
    exit;
}

// Проверка CAPTCHA
if (!isset($_SESSION['captcha_answer']) || 
    !isset($_POST['captcha']) || 
    $_SESSION['captcha_answer'] != $_POST['captcha']) {
    http_response_code(400);
    echo "Invalid CAPTCHA. Please try again.";
    exit;
}

// После проверки капчи удаляем значение из сессии
unset($_SESSION['captcha_answer']);

// Проверка наличия загружаемых файлов
if (!isset($_FILES['file']) || empty($_FILES['file']['name'][0])) {
    http_response_code(400);
    echo "No files uploaded.";
    exit;
}

// Настройки загрузки
$maxFileSize = 10 * 1024 * 1024; // 10MB
$allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
$maxWidth = 5000;
$maxHeight = 5000;
$uploadDir = 'uploads/' . date('Y/m/d/');
$maxFiles = 20;

// Создаем директорию для загрузки, если её нет
if (!file_exists($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

// Обработка загруженных файлов
$uploadedFiles = [];
$errors = [];

// Проверяем количество файлов
if (count($_FILES['file']['name']) > $maxFiles) {
    http_response_code(400);
    echo "You can upload up to $maxFiles files at once.";
    exit;
}

// Обрабатываем каждый файл
for ($i = 0; $i < count($_FILES['file']['name']); $i++) {
    $fileName = $_FILES['file']['name'][$i];
    $fileTmpName = $_FILES['file']['tmp_name'][$i];
    $fileSize = $_FILES['file']['size'][$i];
    $fileError = $_FILES['file']['error'][$i];
    $fileType = $_FILES['file']['type'][$i];
    
    // Проверка ошибок загрузки
    if ($fileError !== UPLOAD_ERR_OK) {
        $errors[] = "Error uploading $fileName: " . getUploadError($fileError);
        continue;
    }
    
    // Проверка размера файла
    if ($fileSize > $maxFileSize) {
        $errors[] = "File $fileName is too large. Maximum size is 10MB.";
        continue;
    }
    
    // Проверка типа файла
    if (!in_array($fileType, $allowedTypes)) {
        $errors[] = "File $fileName is not a valid image type. Only JPEG and PNG are allowed.";
        continue;
    }
    
    // Проверка размеров изображения
    list($width, $height) = getimagesize($fileTmpName);
    if ($width > $maxWidth || $height > $maxHeight) {
        $errors[] = "Image $fileName dimensions exceed maximum allowed (5000x5000px).";
        continue;
    }
    
    // Генерируем уникальное имя файла
    $fileExtension = pathinfo($fileName, PATHINFO_EXTENSION);
    $newFileName = uniqid('img_', true) . '.' . $fileExtension;
    $destination = $uploadDir . $newFileName;
    
    // Перемещаем файл в целевую директорию
    if (move_uploaded_file($fileTmpName, $destination)) {
        // Очистка метаданных EXIF
        cleanMetadata($destination, $fileType);
        
        // Применяем ресайз если нужно
        if (isset($_POST['resize']) && 
            isset($_POST['resize_width']) && 
            isset($_POST['resize_height']) &&
            is_numeric($_POST['resize_width']) && 
            is_numeric($_POST['resize_height'])) {
            
            $newWidth = min(max(400, intval($_POST['resize_width'])), 3000);
            $newHeight = min(max(400, intval($_POST['resize_height'])), 3000);
            
            resizeImage($destination, $fileType, $newWidth, $newHeight);
        }
        
        $uploadedFiles[] = [
            'original_name' => $fileName,
            'saved_name' => $newFileName,
            'url' => $destination,
            'size' => $fileSize
        ];
    } else {
        $errors[] = "Failed to move uploaded file $fileName.";
    }
}

// Если есть ошибки, возвращаем их
if (!empty($errors)) {
    http_response_code(400);
    echo "Errors occurred during upload:<br>" . implode("<br>", $errors);
    exit;
}

// Если файлы успешно загружены, возвращаем успешный ответ
$response = [
    'success' => true,
    'message' => 'Files uploaded successfully.',
    'files' => $uploadedFiles,
    'post_id' => uniqid('post_', true), // Генерируем ID поста, если нужно
    'single_post' => isset($_POST['post']) && $_POST['post'] == 'on'
];

header('Content-Type: application/json');
echo json_encode($response);

// Вспомогательные функции

/**
 * Получает понятное описание ошибки загрузки
 */
function getUploadError($errorCode) {
    switch ($errorCode) {
        case UPLOAD_ERR_INI_SIZE:
            return "The uploaded file exceeds the upload_max_filesize directive in php.ini.";
        case UPLOAD_ERR_FORM_SIZE:
            return "The uploaded file exceeds the MAX_FILE_SIZE directive that was specified in the HTML form.";
        case UPLOAD_ERR_PARTIAL:
            return "The uploaded file was only partially uploaded.";
        case UPLOAD_ERR_NO_FILE:
            return "No file was uploaded.";
        case UPLOAD_ERR_NO_TMP_DIR:
            return "Missing a temporary folder.";
        case UPLOAD_ERR_CANT_WRITE:
            return "Failed to write file to disk.";
        case UPLOAD_ERR_EXTENSION:
            return "A PHP extension stopped the file upload.";
        default:
            return "Unknown upload error.";
    }
}

/**
 * Очищает метаданные EXIF из изображения
 */
function cleanMetadata($filePath, $fileType) {
    try {
        if ($fileType === 'image/jpeg') {
            // Для JPEG просто пересохраняем изображение, удаляя метаданные
            $image = imagecreatefromjpeg($filePath);
            imagejpeg($image, $filePath, 90);
            imagedestroy($image);
        } elseif ($fileType === 'image/png') {
            // Для PNG
            $image = imagecreatefrompng($filePath);
            imagepng($image, $filePath, 9);
            imagedestroy($image);
        }
    } catch (Exception $e) {
        // В случае ошибки просто продолжаем без очистки метаданных
        error_log("Error cleaning metadata: " . $e->getMessage());
    }
}

/**
 * Изменяет размер изображения
 */
function resizeImage($filePath, $fileType, $newWidth, $newHeight) {
    try {
        if ($fileType === 'image/jpeg') {
            $image = imagecreatefromjpeg($filePath);
        } elseif ($fileType === 'image/png') {
            $image = imagecreatefrompng($filePath);
        } else {
            return false;
        }
        
        $originalWidth = imagesx($image);
        $originalHeight = imagesy($image);
        
        // Создаем новое изображение с нужными размерами
        $resizedImage = imagecreatetruecolor($newWidth, $newHeight);
        
        // Сохраняем прозрачность для PNG
        if ($fileType === 'image/png') {
            imagealphablending($resizedImage, false);
            imagesavealpha($resizedImage, true);
            $transparent = imagecolorallocatealpha($resizedImage, 255, 255, 255, 127);
            imagefilledrectangle($resizedImage, 0, 0, $newWidth, $newHeight, $transparent);
        }
        
        // Масштабируем изображение
        imagecopyresampled($resizedImage, $image, 0, 0, 0, 0, $newWidth, $newHeight, $originalWidth, $originalHeight);
        
        // Сохраняем результат
        if ($fileType === 'image/jpeg') {
            imagejpeg($resizedImage, $filePath, 90);
        } elseif ($fileType === 'image/png') {
            imagepng($resizedImage, $filePath, 9);
        }
        
        // Освобождаем память
        imagedestroy($image);
        imagedestroy($resizedImage);
        
        return true;
    } catch (Exception $e) {
        error_log("Error resizing image: " . $e->getMessage());
        return false;
    }
}
?>