<?php

namespace App\Http\Controllers;

use App\Models\Task;
use Illuminate\Http\Request;

class TaskController extends Controller
{
    public function update(Request $request, Task $task)
    {
        $this->authorize('update', $task);

        $task->update($request->all());

        return response()->json($task);
    }
}
