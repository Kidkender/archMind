<?php

use App\Constants\Permissions;
use App\Http\Controllers\TaskController;
use App\Http\Middleware\ResolveTenant;
use Illuminate\Support\Facades\Route;

Route::middleware('auth:sanctum')->group(function () {

    Route::middleware(ResolveTenant::class)->group(function () {

        Route::prefix('tasks')->group(function () {

            Route::middleware('permission:'.Permissions::TASK_VIEW)->group(function () {
                Route::get('/{task}', [TaskController::class, 'show']);
            });

            Route::middleware('permission:'.Permissions::TASK_UPDATE)->group(function () {
                Route::put('/{task}', [TaskController::class, 'update']);
            });

            Route::middleware('permission:'.Permissions::TASK_DELETE)->group(function () {
                Route::delete('/{task}', [TaskController::class, 'destroy']);
            });

        });

    });

});
