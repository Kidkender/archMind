<?php

namespace App\Http\Controllers;

use App\Notifications\WelcomeNotification;
use App\Notifications\OrderShippedNotification;
use App\Mail\OrderConfirmationMail;
use App\Mail\AdminAlertMail;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Mail;
use App\Models\User;
use Illuminate\Http\JsonResponse;

class NotificationController
{
    /**
     * NOTIFICATION-001: Notification and Mail side-effects outside DB::transaction().
     */
    public function notify(User $user): JsonResponse
    {
        // Static Notification facade — should emit ir:notification
        Notification::send($user, new WelcomeNotification());

        // Instance notify() — should emit ir:notification
        $user->notify(new OrderShippedNotification());

        // Mail fluent send — should emit ir:mail (queued=false)
        Mail::to($user)->send(new OrderConfirmationMail());

        // Mail fluent queue — should emit ir:mail (queued=true)
        Mail::to($user->email)->queue(new AdminAlertMail());

        return response()->json(['status' => 'sent']);
    }
}
