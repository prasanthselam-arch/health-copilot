from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlmodel import Session, delete, select

from app.api.deps import current_account
from app.config import get_settings
from app.db import get_session
from app.models.tables import Account, EmailCode, Notification, Patient, PushSubscription
from app.services import auth, codes, mailer
from app.services.notifications import device_name, security_alert
from app.services.records import delete_patient

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    first_name: str
    last_name: str
    email: str
    password: str
    phone: str | None = None


class CodeIn(BaseModel):
    email: str
    code: str


class LoginIn(BaseModel):
    login: str
    password: str


class ForgotIn(BaseModel):
    login: str


class ResetIn(BaseModel):
    login: str
    code: str
    password: str


class EmailIn(BaseModel):
    email: str
    current_password: str | None = None


class EmailCodeIn(BaseModel):
    code: str


class DeleteIn(BaseModel):
    password: str


class AccountPatch(BaseModel):
    name: str | None = None
    login: str | None = None
    phone: str | None = None
    current_password: str | None = None
    notify_security: bool | None = None
    notify_medicines: bool | None = None
    notify_weekly: bool | None = None


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


def _account_out(a: Account) -> dict[str, Any]:
    return {"id": a.id, "name": a.name, "login": a.login, "created_at": a.created_at, "email": a.email, "phone": a.phone,
            "email_verified": a.email_verified_at is not None,
            "notify": {"security": a.notify_security, "medicines": a.notify_medicines, "weekly": a.notify_weekly}}


def _start_session(resp: Response, db: Session, acc: Account) -> None:
    s = get_settings()
    resp.set_cookie(auth.COOKIE, auth.create_session(db, acc), max_age=s.session_days * 86400,
                    httponly=True, samesite="lax", secure=s.cookie_secure, path="/")


def _alert(tasks: BackgroundTasks, acc: Account, event: str, **kw: Any) -> None:
    if acc.email and acc.email_verified_at and acc.notify_security:
        tasks.add_task(security_alert, kw.pop("to", acc.email), acc.name, event, **kw)


def _fail(e: Exception) -> HTTPException:
    if isinstance(e, mailer.MailError):
        return HTTPException(503, str(e))
    return HTTPException(400, str(e))


@router.post("/register/start")
def register_start(body: RegisterIn, db: Session = Depends(get_session)):
    """Check the details and email a code. Nothing is saved until the code is confirmed."""
    try:
        email, details = auth.signup_details(db, body.first_name, body.last_name, body.email, body.password, body.phone)
        return codes.issue(db, email, "signup", payload=details)
    except (auth.AuthError, codes.CodeError, mailer.MailError) as e:
        raise _fail(e) from e


@router.post("/register/verify")
def register_verify(body: CodeIn, resp: Response, db: Session = Depends(get_session)):
    try:
        email = auth.normalize_email(body.email)
        row = codes.check(db, email, "signup", body.code)
        acc = auth.register(db, row.payload or {}, email)
    except (auth.AuthError, codes.CodeError) as e:
        raise _fail(e) from e
    _start_session(resp, db, acc)
    return _account_out(acc)


@router.post("/login")
def login(body: LoginIn, request: Request, resp: Response, tasks: BackgroundTasks, db: Session = Depends(get_session)):
    try:
        acc = auth.authenticate(db, body.login, body.password)
    except auth.AuthError as e:
        raise HTTPException(401, str(e)) from e
    _start_session(resp, db, acc)
    _alert(tasks, acc, "sign_in", device=device_name(request.headers.get("user-agent")))
    return _account_out(acc)


@router.post("/forgot")
def forgot(body: ForgotIn, db: Session = Depends(get_session)):
    """Email a reset code. The reply is the same whether or not the account exists."""
    out: dict[str, Any] = {"sent": True, "expires_in": int(codes.TTL.total_seconds()),
                           "resend_in": int(codes.RESEND_AFTER.total_seconds())}
    try:
        acc = auth.find_account(db, body.login)
        if acc and acc.email and acc.email_verified_at:
            sent = codes.issue(db, acc.email, "reset", account_id=acc.id)
            out.update({k: v for k, v in sent.items() if k == "dev_code"})
    except (auth.AuthError, codes.CodeError, mailer.MailError) as e:
        raise _fail(e) from e
    return out


@router.post("/reset")
def reset(body: ResetIn, resp: Response, tasks: BackgroundTasks, db: Session = Depends(get_session)):
    try:
        acc = auth.find_account(db, body.login)
        if not (acc and acc.email and acc.email_verified_at):
            raise codes.CodeError("This code has expired. Please ask for a new one")
        auth.check_password_strength(body.password)
        codes.check(db, acc.email, "reset", body.code, account_id=acc.id)
        auth.set_password(db, acc, body.password)
    except (auth.AuthError, codes.CodeError) as e:
        raise _fail(e) from e
    _start_session(resp, db, acc)
    _alert(tasks, acc, "password_reset")
    return _account_out(acc)


@router.post("/logout")
def logout(request: Request, resp: Response, db: Session = Depends(get_session)):
    auth.end_session(db, request.cookies.get(auth.COOKIE))
    resp.delete_cookie(auth.COOKIE, path="/")
    return {"signed_out": True}


@router.get("/me")
def me(acc: Account = Depends(current_account)):
    return _account_out(acc)


@router.patch("/me")
def update_me(body: AccountPatch, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        acc = auth.update_account(db, acc, body.name, body.login, body.current_password, body.phone)
    except auth.AuthError as e:
        raise HTTPException(400, str(e)) from e
    for field in ("notify_security", "notify_medicines", "notify_weekly"):
        if (value := getattr(body, field)) is not None:
            setattr(acc, field, value)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return _account_out(acc)


@router.post("/email/start")
def email_start(body: EmailIn, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Add an email, or change a verified one (needs the password), by emailing a code to it."""
    try:
        email = auth.normalize_email(body.email)
        if acc.email_verified_at and email == acc.email:
            raise auth.AuthError("This email is already verified")
        if acc.email_verified_at and not (body.current_password and auth.verify_password(body.current_password, acc.password_hash)):
            raise auth.AuthError("Enter your current password to change your email")
        if auth.email_in_use(db, email, exclude_id=acc.id):
            raise auth.AuthError("Another account already uses this email")
        return codes.issue(db, email, "email", account_id=acc.id)
    except (auth.AuthError, codes.CodeError, mailer.MailError) as e:
        raise _fail(e) from e


@router.post("/email/verify")
def email_verify(body: EmailCodeIn, tasks: BackgroundTasks, acc: Account = Depends(current_account),
                 db: Session = Depends(get_session)):
    old = acc.email if acc.email_verified_at else None
    try:
        email = codes.latest_email(db, "email", acc.id)
        if not email:
            raise codes.CodeError("This code has expired. Please ask for a new one")
        codes.check(db, email, "email", body.code, account_id=acc.id)
        auth.set_email(db, acc, email)
    except (auth.AuthError, codes.CodeError) as e:
        raise _fail(e) from e
    if old and old != email:
        _alert(tasks, acc, "email_changed", to=old, new_email=email)
    return _account_out(acc)


@router.post("/password")
def change_password(body: PasswordIn, request: Request, tasks: BackgroundTasks, acc: Account = Depends(current_account),
                    db: Session = Depends(get_session)):
    """Change the password and sign out every other device."""
    try:
        auth.change_password(db, acc, body.current_password, body.new_password, request.cookies.get(auth.COOKIE))
    except auth.AuthError as e:
        raise HTTPException(400, str(e)) from e
    _alert(tasks, acc, "password_changed")
    return {"changed": True}


@router.post("/delete-account")
def delete_account(body: DeleteIn, resp: Response, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Delete the account and every profile, document and uploaded file it owns."""
    if not auth.verify_password(body.password, acc.password_hash):
        raise HTTPException(401, "Incorrect password")
    for p in db.exec(select(Patient).where(Patient.owner_id == acc.id)).all():
        delete_patient(db, p)
    auth.end_all_sessions(db, acc.id)
    for table in (EmailCode, Notification, PushSubscription):
        db.exec(delete(table).where(table.account_id == acc.id))
    db.delete(acc)
    db.commit()
    resp.delete_cookie(auth.COOKIE, path="/")
    return {"deleted": True}
