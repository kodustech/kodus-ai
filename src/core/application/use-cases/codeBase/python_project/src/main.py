# Imports básicos da stdlib
import os
import sys
from datetime import datetime, timedelta

# Import com alias
import requests as req

# Import relativo do mesmo pacote
from .utils import helper_function
from .models.user import User

# Import relativo do pacote pai
from ..other_module import some_function

# Import com wildcard (não recomendado, mas possível)
from .constants import *

def main():
    # Usando os imports
    current_time = datetime.now()
    user = User("John")
    response = req.get("https://api.example.com")
    helper_function()
    some_function()
    print(CONSTANT_FROM_WILDCARD)
