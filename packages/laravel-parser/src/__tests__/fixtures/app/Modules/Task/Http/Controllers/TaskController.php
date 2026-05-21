<?php

namespace App\Modules\Task\Http\Controllers;

use App\Modules\Task\Requests\UpdateTaskRequest;
use App\Modules\Task\Services\TaskService;

class TaskController
{
    public function __construct(private TaskService $taskService) {}

    public function update(UpdateTaskRequest $request, $id)
    {
        $data = $request->validated();
        $tenant = app('tenant');
        $task = $this->taskService->getTask($tenant->id, $id);
        $this->authorize('update', $task);
        $newTask = $this->taskService->updateTask($task, $data);
        return response()->json($newTask);
    }

    public function index()
    {
        $this->authorize('viewAny', Task::class);
        return response()->json($this->taskService->all());
    }
}
