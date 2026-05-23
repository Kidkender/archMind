<?php

namespace App\Modules\Task\Http\Controllers;

use App\Events\TaskCreated;
use App\Modules\Task\Models\Task;
use App\Modules\Task\Requests\UpdateTaskRequest;
use App\Modules\Task\Services\TaskService;
use App\Services\AuditService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TaskController
{
    public function __construct(
        private TaskService $taskService,
        private readonly AuditService $auditService,
    ) {}

    /**
     * TXN-001: event dispatched inside transaction before commit.
     */
    public function store(Request $request): JsonResponse
    {
        return DB::transaction(function () use ($request) {
            $task = Task::create($request->validated());
            TaskCreated::dispatch($task);
            $this->auditService->log('task.created', $task);
            return response()->json($task, 201);
        });
    }

    /**
     * ISO-001: Task::find without tenant constraint in tenant-scoped route.
     */
    public function show(string $id): JsonResponse
    {
        $tenant = app('tenant');
        $task = Task::find($id);  // ← missing tenant scope
        $this->authorize('view', $task);
        return response()->json($task);
    }

    public function update(UpdateTaskRequest $request, $id)
    {
        $data = $request->validated();
        $tenant = app('tenant');
        $task = $this->taskService->getTask($tenant->id, $id);
        $this->authorize('update', $task);
        $newTask = $this->taskService->updateTask($task, $data);
        return response()->json($newTask);
    }

    public function destroy($id)
    {
        $tenant = app('tenant');
        $task = $this->taskService->getTask($tenant->id, $id);
        $this->authorize('delete', $task);
        $this->taskService->deleteTask($task);
        return response()->json(null, 204);
    }

    public function index()
    {
        $this->authorize('viewAny', Task::class);
        return response()->json($this->taskService->all());
    }
}
