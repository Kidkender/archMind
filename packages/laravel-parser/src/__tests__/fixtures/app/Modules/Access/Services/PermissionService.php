<?php

namespace App\Modules\Access\Services;

use App\Models\User;
use App\Modules\Tenant\Models\Tenant;
use Illuminate\Support\Facades\Cache;

class PermissionService
{
    private const CACHE_TTL = 300;

    public function hasPermission(User $user, Tenant $tenant, string $permission): bool
    {
        $cacheKey = "permissions:{$tenant->id}:{$user->id}";

        $permissions = Cache::remember($cacheKey, self::CACHE_TTL, function () use ($user, $tenant) {
            return $this->loadPermissions($user, $tenant);
        });

        return in_array($permission, $permissions, true);
    }

    private function loadPermissions(User $user, Tenant $tenant): array
    {
        return $user->roles()
            ->wherePivot('tenant_id', $tenant->id)
            ->with('permissions')
            ->get()
            ->flatMap(fn ($role) => $role->permissions->pluck('name'))
            ->unique()
            ->values()
            ->all();
    }
}
