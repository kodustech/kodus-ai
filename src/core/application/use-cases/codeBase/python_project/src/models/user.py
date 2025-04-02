# Import relativo
from ..utils import validate_email

# Import do mesmo diretório
from .base import BaseModel

class User(BaseModel):
    def __init__(self, name: str, email: str = None):
        self.name = name
        self.email = email
        
    def validate(self):
        if self.email:
            return validate_email(self.email)
        return True
