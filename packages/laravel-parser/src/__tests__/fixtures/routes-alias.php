<?php

use App\Http\Controllers\ReportController;
use App\Http\Controllers\ProjectController;
use Illuminate\Support\Facades\Route;

// ADV-ALIAS-001: middleware alias that requires Kernel.php resolution
Route::middleware(['auth:sanctum', 'role:admin'])->group(function () {
    Route::get('/reports', [ReportController::class, 'index']);
});

// ADV-NESTED-001 variant: alias in nested groups
Route::middleware(['auth:sanctum'])->group(function () {
    Route::middleware(['tenant'])->prefix('projects')->group(function () {
        Route::put('/{project}', [ProjectController::class, 'update']);
    });
});
