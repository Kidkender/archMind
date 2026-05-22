<?php

namespace App\Traits;

use Illuminate\Auth\Access\AuthorizationException;

trait HasProjectScope
{
    /**
     * Override authorize() to add ownership gate before delegating to policy.
     * This interception is invisible to static call-graph analysis.
     */
    public function authorize($ability, $arguments = [])
    {
        $project = is_array($arguments) ? ($arguments[0] ?? null) : $arguments;

        if ($project && $project->owner_id !== auth()->id()) {
            throw new AuthorizationException('You do not own this project.');
        }

        return parent::authorize($ability, $arguments);
    }
}
