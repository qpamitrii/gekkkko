<?php

	// Проверяем, что запрос пришел с нашего домена
	$allowed_domains = ['yourdomain.com', 'www.yourdomain.com']; // Замените на ваш домен
	$referer = parse_url($_SERVER['HTTP_REFERER'] ?? '', PHP_URL_HOST);

	if (!in_array($referer, $allowed_domains) && php_sapi_name() !== 'cli') {
		http_response_code(403);
		exit('Access denied');
	}



	session_start();
	$string = "";
	for ($i = 0; $i < 5; $i++)
		$string .= chr(rand(97, 122));
	
	$_SESSION['rand_code'] = $string;

	$dir = "fonts/";

	$image = imagecreatetruecolor(170, 60);
	$black = imagecolorallocate($image, 0, 0, 0);
	$color = imagecolorallocate($image, 200, 100, 90);
	$white = imagecolorallocate($image, 255, 255, 255);

	imagefilledrectangle($image,0,0,399,99,$white);
	imagettftext ($image, 30, 0, 10, 40, $color, $dir."verdana.ttf", $_SESSION['rand_code']);

	header("Content-type: image/png");
	imagepng($image);
?>