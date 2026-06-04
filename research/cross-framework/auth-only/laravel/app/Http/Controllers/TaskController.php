<?php

namespace App\Http\Controllers;

use App\Models\Task;

class TaskController extends Controller
{
    public function show(Task $task)
    {
        return response()->json($task);
    }
}
