<?php

namespace App\Modules\Task\Http\Controllers;

use App\Events\TaskCreated;
use App\Jobs\ProcessTaskReport;
use App\Modules\Task\Models\Task;
use App\Services\AuditService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TaskController
{
    public function __construct(
        private readonly AuditService $auditService,
    ) {}

    /**
     * Event dispatched inside transaction — TXN-001 scenario.
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
     * No transaction escape — safe pattern.
     */
    public function update(Request $request, Task $task): JsonResponse
    {
        return DB::transaction(function () use ($request, $task) {
            $task->update($request->validated());
            $this->auditService->log('task.updated', $task);
            return response()->json($task);
        });
    }

    /**
     * Job dispatched inside transaction — also an escape.
     */
    public function destroy(Task $task): JsonResponse
    {
        return DB::transaction(function () use ($task) {
            $task->delete();
            ProcessTaskReport::dispatch($task->id);
            return response()->json(null, 204);
        });
    }
}
