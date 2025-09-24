<?php
session_start();

// Генерация случайного математического выражения
$num1 = rand(1, 10);
$num2 = rand(1, 10);
$operators = ['+', '-', '*'];
$operator = $operators[array_rand($operators)];

switch($operator) {
    case '+': $result = $num1 + $num2; break;
    case '-': $result = $num1 - $num2; break;
    case '*': $result = $num1 * $num2; break;
}

// Сохранение ответа в сессии
$_SESSION['captcha_answer'] = $result;

// Отправка данных капчи в формате JSON
header('Content-Type: application/json');
echo json_encode([
    'expression' => "$num1 $operator $num2 = ?",
    'answer' => $result
]);
?>