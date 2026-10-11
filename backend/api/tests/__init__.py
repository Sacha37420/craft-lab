"""Tests backend de craft-lab — `python manage.py test`.

Aucun réseau : le JWKS de Keycloak est remplacé par une clé locale, les appels
à `storage` et aux fournisseurs IA sont simulés (cf. base.py). Les réglages
sensibles sont surchargés : rien ici ne dépend du contenu du `.env`.
"""
