<?php

namespace App\Controllers;

// Import de classes
use App\Models\User;
use App\Services\AuthService;

// Import com alias
use App\Services\ValidationService as Validator;

// Import múltiplo
use App\Exceptions\{
    UserNotFoundException,
    ValidationException
};

// Import de função e constante
use function App\Helpers\format_date;
use const App\Config\MAX_ATTEMPTS;

class UserController
{
    private AuthService $auth;
    private Validator $validator;

    public function __construct()
    {
        $this->auth = new AuthService();
        $this->validator = new Validator();
    }

    public function show($id)
    {
        $user = User::find($id);
        if (!$user) {
            throw new UserNotFoundException();
        }
        return $user;
    }
}
