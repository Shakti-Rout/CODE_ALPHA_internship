from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User

from .models import Post, Profile, Comment


class SignUpForm(UserCreationForm):
    email = forms.EmailField(required=True)

    class Meta(UserCreationForm.Meta):
        model = User
        fields = ("username", "email", "password1", "password2")

    def save(self, commit=True):
        user = super().save(commit=False)
        user.email = self.cleaned_data["email"]
        if commit:
            user.save()
            Profile.objects.get_or_create(user=user)
        return user


class PostForm(forms.ModelForm):
    class Meta:
        model = Post
        fields = ("body", "image_url")
        widgets = {
            "body": forms.Textarea(attrs={"rows": 3, "placeholder": "What’s happening in your world?"}),
            "image_url": forms.URLInput(attrs={"placeholder": "Optional image URL"}),
        }


class CommentForm(forms.ModelForm):
    class Meta:
        model = Comment
        fields = ("body",)
        widgets = {
            "body": forms.TextInput(attrs={"placeholder": "Write a comment…", "maxlength": 500}),
        }


class ProfileForm(forms.ModelForm):
    class Meta:
        model = Profile
        fields = ("bio", "avatar_url")
        widgets = {
            "bio": forms.Textarea(attrs={"rows": 3, "placeholder": "A little about you"}),
            "avatar_url": forms.URLInput(attrs={"placeholder": "https://example.com/photo.jpg"}),
        }
