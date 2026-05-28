<?php

namespace App\Listeners;

use App\Events\TaskCreated;
use Illuminate\Contracts\Queue\ShouldQueue;

class SendTaskCreatedNotification implements ShouldQueue
{
    public function handle(TaskCreated $event): void
    {
        // Send notification email
    }
}
