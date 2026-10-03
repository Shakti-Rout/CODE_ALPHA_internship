from django.urls import path

from . import views

urlpatterns = [
    path("", views.feed, name="feed"),
    path("signup/", views.signup, name="signup"),
    path("profile/edit/", views.edit_profile, name="edit_profile"),
    path("profile/<str:username>/", views.profile, name="profile"),
    path("posts/<int:post_id>/comment/", views.add_comment, name="add_comment"),
    path("posts/<int:post_id>/like/", views.toggle_like, name="toggle_like"),
    path("users/<str:username>/follow/", views.toggle_follow, name="toggle_follow"),
]
