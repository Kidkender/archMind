<?php

use BookStack\Entities\Controllers as EntityControllers;
use Illuminate\Support\Facades\Route;

Route::put('pages/{id}', [EntityControllers\PageApiController::class, 'update']);
