<?php

// Include from routes/api.php: require __DIR__.'/limenia.php';
// The api group has no CSRF check, which the webhook needs.

use App\Http\Controllers\LimeniaController;
use App\Http\Controllers\LimeniaWebhookController;
use Illuminate\Support\Facades\Route;

// For your app. Put these behind your auth middleware (e.g. auth:sanctum).
Route::post('/reports', [LimeniaController::class, 'createReport']);
Route::get('/me/moderation-status', [LimeniaController::class, 'myStatus']);
Route::post('/devices/request-hash', [LimeniaController::class, 'deviceRequestHash']);
Route::post('/devices/check', [LimeniaController::class, 'deviceCheck']);

// For Limenia. No auth middleware: the signature is the authentication.
Route::post('/limenia/webhook', LimeniaWebhookController::class);
