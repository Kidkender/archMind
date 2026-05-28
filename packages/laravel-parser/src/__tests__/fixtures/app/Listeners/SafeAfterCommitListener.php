<?php

namespace App\Listeners;

use App\Events\TaskCreated;
use Illuminate\Contracts\Events\ShouldHandleEventsAfterCommit;

class SafeAfterCommitListener implements ShouldHandleEventsAfterCommit
{
    public function handle(TaskCreated $event): void
    {
        // Runs after transaction commits — safe
    }
}
