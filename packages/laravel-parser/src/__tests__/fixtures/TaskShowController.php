<?php

namespace App\Modules\Task\Http\Controllers;

use App\Modules\Task\Models\Task;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class TaskShowController
{
    /**
     * Unscoped — ISO-001 bug: no tenant constraint on find.
     */
    public function show(string $id): JsonResponse
    {
        $tenant = app('tenant');

        $task = Task::find($id);  // ← missing tenant scope

        $this->authorize('view', $task);

        return response()->json($task);
    }

    /**
     * Safe — explicit where tenant_id constraint.
     */
    public function showSafe(string $id): JsonResponse
    {
        $tenant = app('tenant');

        $task = Task::where('tenant_id', $tenant->id)->findOrFail($id);

        return response()->json($task);
    }

    /**
     * Safe via method chaining with tenant signal.
     */
    public function showByTenant(string $id): JsonResponse
    {
        $task = Task::whereTenantId(app('tenant')->id)->find($id);

        return response()->json($task);
    }
}
