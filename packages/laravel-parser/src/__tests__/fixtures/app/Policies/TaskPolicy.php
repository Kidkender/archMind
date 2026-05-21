<?php

namespace App\Policies;

use App\Models\User;
use App\Modules\Task\Models\Task;
use App\Modules\Access\Services\PermissionService;

class TaskPolicy
{
    public function __construct(private PermissionService $permissionService) {}

    public function viewAny(User $user): bool
    {
        $tenant = app('tenant');
        return $this->permissionService->hasPermission($user, $tenant, 'TASK_VIEW_ANY');
    }

    public function view(User $user, Task $task): bool
    {
        $tenant = app('tenant');
        return $this->permissionService->hasPermission($user, $tenant, 'TASK_VIEW')
            && $task->tenant_id === $tenant->id;
    }

    public function update(User $user, Task $task): bool
    {
        $tenant = app('tenant');
        return $this->permissionService->hasPermission($user, $tenant, 'TASK_UPDATE')
            && $task->tenant_id === $tenant->id;
    }

    public function delete(User $user, Task $task): bool
    {
        $tenant = app('tenant');

        if (! $this->permissionService->hasPermission($user, $tenant, 'TASK_DELETE')) {
            return false;
        }

        if (! $this->permissionService->hasPermission($user, $tenant, 'TASK_DELETE_ANY')) {
            return $task->assignee_id === $user->id;
        }

        return true;
    }
}
