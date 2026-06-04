<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreTaskRequest;

class TaskController extends Controller
{
    public function store(StoreTaskRequest $request)
    {
        return response()->json(['created' => true]);
    }
}
