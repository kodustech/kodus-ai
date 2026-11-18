from django.urls import path

from . import views

urlpatterns = [
    path("items/", views.item_list),
    path("items/<int:pk>/", views.item_detail),
]
