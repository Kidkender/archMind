<?php

namespace App\Modules\Role\Http\Controllers;

use App\Modules\Role\Requests\AssignRoleRequest;
use App\Modules\Role\Services\RoleService;
use App\Modules\Access\Services\PermissionService;
use Illuminate\Http\JsonResponse;

class RoleController
{
    public function __construct(
        private RoleService $roleService,
        private PermissionService $permissionService,
    ) {}

    public function assign(AssignRoleRequest $request, string $userId): JsonResponse
    {
        $this->authorize('assign', Role::class);
        $this->validateRequestedRoleLevel($request);
        $this->roleService->assignRole($userId, $request->role);
        return response()->json(['assigned' => true]);
    }

    private function validateRequestedRoleLevel(AssignRoleRequest $request): void
    {
        $this->permissionService->checkRoleHierarchy($request->role);
    }

    private function ensureNotSelfAssign(string $userId): void
    {
        $this->permissionService->assertNotSelf($userId);
        $this->roleService->lockForAssign($userId);
    }
}
