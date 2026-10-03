from django.contrib import messages
from django.contrib.auth import get_user_model, login
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Exists, OuterRef, Prefetch
from django.shortcuts import get_object_or_404, redirect, render
from django.db.models import Q
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST

from .forms import CommentForm, PostForm, ProfileForm, SignUpForm
from .models import Comment, Follow, Like, Post, Profile

User = get_user_model()


def _ensure_profile(user):
    Profile.objects.get_or_create(user=user)


def _action_redirect(request, default="feed"):
    next_url = request.POST.get("next", "")
    if next_url and url_has_allowed_host_and_scheme(
        next_url,
        allowed_hosts={request.get_host()},
        require_https=request.is_secure(),
    ):
        return redirect(next_url)
    return redirect(default)


def _posts_for(user=None):
    posts = Post.objects.select_related("author", "author__profile").prefetch_related(
        Prefetch("comments", queryset=Comment.objects.select_related("author", "author__profile")),
    ).annotate(like_count=Count("likes", distinct=True), comment_count=Count("comments", distinct=True))
    if user and user.is_authenticated:
        posts = posts.annotate(
            liked_by_viewer=Exists(Like.objects.filter(post=OuterRef("pk"), user=user))
        )
    return posts


def feed(request):
    post_form = PostForm()
    search_query = request.GET.get("q", "").strip()
    if request.method == "POST":
        if not request.user.is_authenticated:
            return redirect("login")
        post_form = PostForm(request.POST)
        if post_form.is_valid():
            post = post_form.save(commit=False)
            post.author = request.user
            post.save()
            messages.success(request, "Your post is live.")
            return redirect("feed")

    posts = _posts_for(request.user)
    if request.GET.get("feed") == "following" and request.user.is_authenticated:
        following_ids = Follow.objects.filter(follower=request.user).values_list("followed_id", flat=True)
        posts = posts.filter(author_id__in=[*following_ids, request.user.id])
    if search_query:
        posts = posts.filter(
            Q(body__icontains=search_query) | Q(author__username__icontains=search_query)
        )

    suggested_users = User.objects.exclude(id=request.user.id if request.user.is_authenticated else None)
    if search_query:
        suggested_users = suggested_users.filter(
            Q(username__icontains=search_query)
            | Q(first_name__icontains=search_query)
            | Q(last_name__icontains=search_query)
        )
    if request.user.is_authenticated:
        already_following = Follow.objects.filter(follower=request.user, followed=OuterRef("pk"))
        suggested_users = suggested_users.annotate(is_following=Exists(already_following))
    suggested_users = suggested_users.select_related("profile").annotate(
        follower_count=Count("followers", distinct=True)
    ).order_by("-follower_count", "username")[:5]

    return render(request, "network/feed.html", {
        "posts": posts,
        "post_form": post_form,
        "suggested_users": suggested_users,
        "active_feed": request.GET.get("feed", "for-you"),
        "search_query": search_query,
    })


def signup(request):
    if request.user.is_authenticated:
        return redirect("feed")
    form = SignUpForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user)
        messages.success(request, "Welcome to Commonroom. Your profile is ready.")
        return redirect("feed")
    return render(request, "network/signup.html", {"form": form})


def profile(request, username):
    profile_user = get_object_or_404(User.objects.select_related("profile"), username=username)
    posts = _posts_for(request.user).filter(author=profile_user)
    is_following = False
    if request.user.is_authenticated and request.user != profile_user:
        is_following = Follow.objects.filter(follower=request.user, followed=profile_user).exists()
    context = {
        "profile_user": profile_user,
        "posts": posts,
        "is_following": is_following,
        "follower_count": profile_user.followers.count(),
        "following_count": profile_user.following.count(),
        "post_count": profile_user.posts.count(),
    }
    return render(request, "network/profile.html", context)


@login_required
def edit_profile(request):
    _ensure_profile(request.user)
    form = ProfileForm(request.POST or None, instance=request.user.profile)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, "Your profile has been updated.")
        return redirect("profile", username=request.user.username)
    return render(request, "network/edit_profile.html", {"form": form})


@login_required
@require_POST
def toggle_like(request, post_id):
    post = get_object_or_404(Post, pk=post_id)
    like, created = Like.objects.get_or_create(post=post, user=request.user)
    if not created:
        like.delete()
    return _action_redirect(request)


@login_required
@require_POST
def add_comment(request, post_id):
    post = get_object_or_404(Post, pk=post_id)
    form = CommentForm(request.POST)
    if form.is_valid():
        comment = form.save(commit=False)
        comment.post = post
        comment.author = request.user
        comment.save()
    else:
        messages.error(request, "Comments must be 500 characters or fewer.")
    return _action_redirect(request)


@login_required
@require_POST
def toggle_follow(request, username):
    followed = get_object_or_404(User, username=username)
    profile_url = reverse("profile", kwargs={"username": username})
    if followed == request.user:
        messages.error(request, "You cannot follow yourself.")
        return _action_redirect(request, profile_url)
    follow, created = Follow.objects.get_or_create(follower=request.user, followed=followed)
    if not created:
        follow.delete()
    return _action_redirect(request, profile_url)
