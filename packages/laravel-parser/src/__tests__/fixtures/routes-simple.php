<?php

use App\Http\Controllers\TaskController;
use Illuminate\Support\Facades\Route;

// Simple flat routes (no middleware)
Route::get('/health', [TaskController::class, 'health']);
Route::post('/tasks', [TaskController::class, 'store']);
