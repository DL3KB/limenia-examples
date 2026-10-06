<?php

return [
    // Address of Limenia, without /v1.
    'base_url' => env('LIMENIA_BASE_URL', 'https://app.limenia.eu'),

    // API key of your app. Keep it on the server.
    'api_key' => env('LIMENIA_API_KEY'),

    // The current webhook secret and, only while rotating, the previous one.
    'webhook_secrets' => array_values(array_filter([
        env('LIMENIA_WEBHOOK_SECRET'),
        env('LIMENIA_WEBHOOK_SECRET_PREVIOUS'),
    ])),
];
