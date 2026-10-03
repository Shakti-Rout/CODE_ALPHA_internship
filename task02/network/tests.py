from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse

from .models import Comment, Follow, Like, Post, Profile


class SocialNetworkTests(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(username="alex", password="strong-password-123")
        self.sam = User.objects.create_user(username="sam", password="strong-password-123")
        self.alex.profile.bio = "Loves the outdoors"
        self.alex.profile.save()
        self.post = Post.objects.create(author=self.sam, body="A sunny day outside.")

    def test_feed_renders_posts_and_profiles(self):
        response = self.client.get(reverse("feed"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "A sunny day outside.")
        self.assertContains(response, "@sam")

    def test_signed_in_user_can_create_post(self):
        self.client.login(username="alex", password="strong-password-123")
        response = self.client.post(reverse("feed"), {"body": "Hello, Commonroom!"})
        self.assertRedirects(response, reverse("feed"))
        self.assertTrue(Post.objects.filter(author=self.alex, body="Hello, Commonroom!").exists())

    def test_user_can_like_and_unlike_post(self):
        self.client.login(username="alex", password="strong-password-123")
        url = reverse("toggle_like", args=[self.post.pk])
        self.client.post(url)
        self.assertTrue(Like.objects.filter(post=self.post, user=self.alex).exists())
        self.client.post(url)
        self.assertFalse(Like.objects.filter(post=self.post, user=self.alex).exists())

    def test_user_can_comment_and_follow(self):
        self.client.login(username="alex", password="strong-password-123")
        profile_url = reverse("profile", args=["sam"])
        self.client.post(reverse("add_comment", args=[self.post.pk]), {
            "body": "Looks lovely!",
            "next": profile_url,
        })
        response = self.client.post(reverse("toggle_follow", args=["sam"]), {"next": profile_url})
        self.assertTrue(Comment.objects.filter(post=self.post, author=self.alex, body="Looks lovely!").exists())
        self.assertTrue(Follow.objects.filter(follower=self.alex, followed=self.sam).exists())
        self.assertRedirects(response, profile_url)

    def test_like_returns_to_profile_and_rejects_external_redirect(self):
        self.client.login(username="alex", password="strong-password-123")
        profile_url = reverse("profile", args=["sam"])
        response = self.client.post(reverse("toggle_like", args=[self.post.pk]), {"next": profile_url})
        self.assertRedirects(response, profile_url)
        response = self.client.post(reverse("toggle_like", args=[self.post.pk]), {"next": "//example.com"})
        self.assertRedirects(response, reverse("feed"))

    def test_follow_without_next_returns_to_profile_and_disallows_self_follow(self):
        self.client.login(username="alex", password="strong-password-123")
        response = self.client.post(reverse("toggle_follow", args=["sam"]))
        self.assertRedirects(response, reverse("profile", args=["sam"]))
        response = self.client.post(reverse("toggle_follow", args=["alex"]))
        self.assertRedirects(response, reverse("profile", args=["alex"]))
        self.assertFalse(Follow.objects.filter(follower=self.alex, followed=self.alex).exists())

    def test_search_finds_posts_and_people(self):
        response = self.client.get(reverse("feed"), {"q": "sunny"})
        self.assertContains(response, "A sunny day outside.")
        self.assertContains(response, 'value="sunny"')

    def test_profile_edit_is_authenticated(self):
        response = self.client.get(reverse("edit_profile"))
        self.assertRedirects(response, f"{reverse('login')}?next={reverse('edit_profile')}")
        self.client.login(username="alex", password="strong-password-123")
        response = self.client.post(reverse("edit_profile"), {"bio": "Coffee and code", "avatar_url": ""})
        self.assertRedirects(response, reverse("profile", args=["alex"]))
        self.alex.profile.refresh_from_db()
        self.assertEqual(self.alex.profile.bio, "Coffee and code")

    def test_signup_creates_profile(self):
        response = self.client.post(reverse("signup"), {
            "username": "newperson",
            "email": "newperson@example.com",
            "password1": "ComplexPass!532",
            "password2": "ComplexPass!532",
        })
        self.assertRedirects(response, reverse("feed"))
        self.assertTrue(Profile.objects.filter(user__username="newperson").exists())
