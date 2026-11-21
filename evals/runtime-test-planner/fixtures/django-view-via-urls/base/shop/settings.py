import os

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev")
DEBUG = False
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = ["items"]
ROOT_URLCONF = "shop.urls"
DATABASES = {}
