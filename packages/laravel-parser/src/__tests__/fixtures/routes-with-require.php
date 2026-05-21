<?php

use App\Http\Middleware\ResolveTenant;
use Illuminate\Support\Facades\Route;

Route::middleware('auth:sanctum')->group(function () {
    Route::middleware(ResolveTenant::class)->group(function () {
        require __DIR__.'/routes-sub.php';
    });
});
