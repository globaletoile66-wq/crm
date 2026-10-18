import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const runtime = 'nodejs';

interface OnboardingPayload {
  companyName?: string;
  country?: string;
  city?: string;
  address?: string;
  adminFirstName?: string;
  adminLastName?: string;
  adminEmail?: string;
  adminPhone?: string;
  planCode?: string;
}

interface SubscriptionPlan {
  id: string;
  code: string;
  name: string;
  price: number;
  currency: string;
  duration_days: number;
}

function jsonError(message: string, status = 400) {
  return NextResponse.json(
    {
      success: false,
      error: message,
    },
    { status },
  );
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeText(value?: string | null) {
  return value?.trim() || null;
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const secretKey =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL est manquante.');
  }

  if (!secretKey) {
    throw new Error(
      'SUPABASE_SECRET_KEY ou SUPABASE_SERVICE_ROLE_KEY est manquante.',
    );
  }

  return createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function getSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

function getFedaPayBaseUrl() {
  return process.env.FEDAPAY_ENV === 'live'
    ? 'https://api.fedapay.com'
    : 'https://sandbox-api.fedapay.com';
}

async function createFedaPayTransaction(params: {
  organizationId: string;
  subscriptionId: string;
  plan: SubscriptionPlan;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
}) {
  const secretKey = process.env.FEDAPAY_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      'FEDAPAY_SECRET_KEY est manquante. Configure la clé secrète FedaPay avant de lancer les paiements.',
    );
  }

  const siteUrl = getSiteUrl();
  const baseUrl = getFedaPayBaseUrl();

  const merchantReference = `JDV-${params.organizationId.slice(0, 8)}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;

  /*
   * Les plans JDV sont actuellement enregistrés avec leur devise
   * dans subscription_plans. On utilise donc cette devise au lieu
   * d'inventer une conversion.
   */
  if (!Number.isInteger(params.plan.price) || params.plan.price < 0) {
    throw new Error(
      `Le montant du plan ${params.plan.code} doit être un entier positif pour FedaPay.`,
    );
  }

  if (params.plan.price === 0) {
    return {
      transaction: null,
      paymentUrl: null,
      merchantReference,
    };
  }

  const transactionResponse = await fetch(
    `${baseUrl}/v1/transactions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: `Abonnement JDV CRM — ${params.plan.name}`,
        amount: params.plan.price,
        currency: {
          iso: params.plan.currency,
        },
        callback_url:
          `${siteUrl}/paiement-retour` +
          `?organization_id=${encodeURIComponent(params.organizationId)}` +
          `&subscription_id=${encodeURIComponent(params.subscriptionId)}`,
        merchant_reference: merchantReference,
        custom_metadata: {
          organization_id: params.organizationId,
          subscription_id: params.subscriptionId,
          plan_code: params.plan.code,
          product: 'JDV_CRM_SUBSCRIPTION',
        },
        customer: {
          firstname: params.firstName,
          lastname: params.lastName,
          email: params.email,
          ...(params.phone
            ? {
                phone_number: {
                  number: params.phone,
                  country: 'bj',
                },
              }
            : {}),
        },
      }),
    },
  );

  const transactionData = await transactionResponse.json();

  if (!transactionResponse.ok) {
    throw new Error(
      transactionData?.message ||
        transactionData?.error ||
        'FedaPay a refusé la création de la transaction.',
    );
  }

  const transactionId = transactionData?.id;

  if (!transactionId) {
    throw new Error(
      'FedaPay a créé une réponse sans identifiant de transaction.',
    );
  }

  const tokenResponse = await fetch(
    `${baseUrl}/v1/transactions/${transactionId}/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    throw new Error(
      tokenData?.message ||
        tokenData?.error ||
        'Impossible de générer le lien de paiement FedaPay.',
    );
  }

  if (!tokenData?.url) {
    throw new Error(
      'FedaPay n’a pas retourné de lien de paiement.',
    );
  }

  return {
    transaction: transactionData,
    paymentUrl: tokenData.url,
    merchantReference,
  };
}

export async function POST(request: Request) {
  let supabaseAdmin: ReturnType<typeof getSupabaseAdmin> | null = null;

  let createdUserId: string | null = null;
  let createdOrganizationId: string | null = null;
  let createdSubscriptionId: string | null = null;

  try {
    const body =
      (await request.json()) as OnboardingPayload;

    const companyName = normalizeText(body.companyName);
    const country = normalizeText(body.country) || 'Bénin';
    const city = normalizeText(body.city);
    const address = normalizeText(body.address);

    const firstName = normalizeText(body.adminFirstName);
    const lastName = normalizeText(body.adminLastName);
    const email = body.adminEmail
      ? normalizeEmail(body.adminEmail)
      : '';
    const phone = normalizeText(body.adminPhone);

    const planCode = body.planCode
      ?.trim()
      .toUpperCase();

    if (!companyName) {
      return jsonError(
        'Le nom de l’entreprise est obligatoire.',
      );
    }

    if (!firstName) {
      return jsonError(
        'Le prénom de l’administrateur est obligatoire.',
      );
    }

    if (!lastName) {
      return jsonError(
        'Le nom de l’administrateur est obligatoire.',
      );
    }

    if (!email || !email.includes('@')) {
      return jsonError(
        'Une adresse email administrateur valide est obligatoire.',
      );
    }

    if (!phone) {
      return jsonError(
        'Le numéro de téléphone administrateur est obligatoire.',
      );
    }

    const allowedPlans = new Set([
      'MONTHLY',
      'QUARTERLY',
      'SEMESTER',
      'ANNUAL',
    ]);

    if (!planCode || !allowedPlans.has(planCode)) {
      return jsonError(
        'Le forfait sélectionné est invalide.',
      );
    }

    supabaseAdmin = getSupabaseAdmin();

    /*
     * Vérification préalable :
     * on évite de créer une deuxième entreprise avec
     * la même adresse email d’entreprise.
     */
    const { data: existingOrganization, error: organizationLookupError } =
      await supabaseAdmin
        .from('organizations')
        .select('id')
        .eq('email', email)
        .maybeSingle();

    if (organizationLookupError) {
      throw organizationLookupError;
    }

    if (existingOrganization) {
      return jsonError(
        'Une entreprise utilise déjà cette adresse email.',
        409,
      );
    }

    /*
     * Récupération du plan actuel dans Supabase.
     */
    const { data: plan, error: planError } =
      await supabaseAdmin
        .from('subscription_plans')
        .select(
          'id, code, name, price, currency, duration_days',
        )
        .eq('code', planCode)
        .eq('active', true)
        .maybeSingle();

    if (planError) {
      throw planError;
    }

    if (!plan) {
      return jsonError(
        'Le forfait sélectionné n’existe pas ou n’est plus actif.',
        400,
      );
    }

    /*
     * 1. Création du compte Auth.
     *
     * L’administrateur reçoit une invitation Supabase
     * afin de définir lui-même son accès.
     *
     * Aucun mot de passe n’est généré ou exposé ici.
     */
    const { data: invitedUser, error: inviteError } =
      await supabaseAdmin.auth.admin.inviteUserByEmail(
        email,
        {
          data: {
            first_name: firstName,
            last_name: lastName,
            display_name: `${firstName} ${lastName}`.trim(),
            phone,
            country,
          },
          redirectTo: `${getSiteUrl()}/business/login`,
        },
      );

    if (inviteError || !invitedUser.user) {
      const message =
        inviteError?.message ||
        'Impossible de créer le compte administrateur.';

      if (
        message.toLowerCase().includes('already') ||
        message.toLowerCase().includes('registered')
      ) {
        return jsonError(
          'Cette adresse email possède déjà un compte JDV CRM.',
          409,
        );
      }

      throw new Error(message);
    }

    createdUserId = invitedUser.user.id;

    /*
     * 2. Profile
     */
    const { error: profileError } =
      await supabaseAdmin
        .from('profiles')
        .insert({
          id: createdUserId,
          first_name: firstName,
          last_name: lastName,
          display_name: `${firstName} ${lastName}`.trim(),
          phone,
          preferred_language: 'fr',
          country,
          status: 'active',
        });

    if (profileError) {
      throw profileError;
    }

    /*
     * 3. Organization
     *
     * L’entreprise reste pending/inactive jusqu’à
     * validation du paiement.
     */
    const { data: organization, error: organizationError } =
      await supabaseAdmin
        .from('organizations')
        .insert({
          name: companyName,
          legal_name: companyName,
          email,
          phone,
          whatsapp: phone,
          country,
          currency: 'XOF',
          timezone: 'Africa/Porto-Novo',
          language: 'fr',
          address,
          city,
          status: 'pending',
          subscription_status: 'inactive',
          owner_user_id: createdUserId,
        })
        .select('id')
        .single();

    if (organizationError || !organization) {
      throw organizationError || new Error(
        'Impossible de créer l’entreprise.',
      );
    }

    createdOrganizationId = organization.id;

    /*
     * 4. Organization member
     */
    const { error: memberError } =
      await supabaseAdmin
        .from('organization_members')
        .insert({
          organization_id: createdOrganizationId,
          user_id: createdUserId,
          role: 'business_admin',
          status: 'active',
        });

    if (memberError) {
      throw memberError;
    }

    /*
     * 5. Subscription
     */
    const { data: subscription, error: subscriptionError } =
      await supabaseAdmin
        .from('organization_subscriptions')
        .insert({
          organization_id: createdOrganizationId,
          plan_id: plan.id,
          status: 'pending',
          auto_renew: false,
        })
        .select('id')
        .single();

    if (subscriptionError || !subscription) {
      throw subscriptionError || new Error(
        'Impossible de créer l’abonnement.',
      );
    }

    createdSubscriptionId = subscription.id;

    /*
     * 6. Paiement interne en attente
     */
    const { data: subscriptionPayment, error: paymentError } =
      await supabaseAdmin
        .from('subscription_payments')
        .insert({
          organization_id: createdOrganizationId,
          subscription_id: createdSubscriptionId,
          amount: plan.price,
          currency: plan.currency,
          provider: 'fedapay',
          payment_method: 'online',
          status: 'pending',
          metadata: {
            product: 'JDV_CRM_SUBSCRIPTION',
            plan_code: plan.code,
            created_from: 'onboarding',
          },
        })
        .select('id')
        .single();

    if (paymentError) {
      throw paymentError;
    }

    /*
     * 7. Création de la transaction FedaPay
     */
    const fedapay = await createFedaPayTransaction({
      organizationId: createdOrganizationId,
      subscriptionId: createdSubscriptionId,
      plan,
      email,
      firstName,
      lastName,
      phone,
    });

    /*
     * 8. Mise à jour du paiement interne avec
     * la référence FedaPay.
     */
    if (subscriptionPayment?.id) {
      const { error: updatePaymentError } =
        await supabaseAdmin
          .from('subscription_payments')
          .update({
            provider_reference:
              fedapay.transaction?.reference ||
              fedapay.transaction?.id?.toString() ||
              fedapay.merchantReference,
            metadata: {
              product: 'JDV_CRM_SUBSCRIPTION',
              plan_code: plan.code,
              transaction_id:
                fedapay.transaction?.id ?? null,
              transaction_reference:
                fedapay.transaction?.reference ?? null,
              merchant_reference:
                fedapay.merchantReference,
            },
          })
          .eq('id', subscriptionPayment.id);

      if (updatePaymentError) {
        throw updatePaymentError;
      }
    }

    /*
     * Pour les plans payants, le checkout URL est obligatoire.
     */
    if (plan.price > 0 && !fedapay.paymentUrl) {
      throw new Error(
        'Le lien de paiement n’a pas pu être généré.',
      );
    }

    return NextResponse.json({
      success: true,
      organizationId: createdOrganizationId,
      subscriptionId: createdSubscriptionId,
      userId: createdUserId,
      planCode: plan.code,
      checkoutUrl: fedapay.paymentUrl,
      requiresPayment: plan.price > 0,
      message:
        plan.price > 0
          ? 'Entreprise créée. Redirection vers le paiement.'
          : 'Entreprise créée.',
    });
  } catch (error) {
    /*
     * Nettoyage de sécurité.
     *
     * On ne supprime aucune donnée existante.
     * On ne nettoie que les enregistrements créés
     * par CETTE tentative d’inscription.
     */
    if (supabaseAdmin) {
      if (createdOrganizationId) {
        await supabaseAdmin
          .from('subscription_payments')
          .delete()
          .eq('organization_id', createdOrganizationId);
      }

      if (createdSubscriptionId) {
        await supabaseAdmin
          .from('organization_subscriptions')
          .delete()
          .eq('id', createdSubscriptionId);
      }

      if (createdOrganizationId) {
        await supabaseAdmin
          .from('organization_members')
          .delete()
          .eq('organization_id', createdOrganizationId);

        await supabaseAdmin
          .from('organizations')
          .delete()
          .eq('id', createdOrganizationId);
      }

      if (createdUserId) {
        await supabaseAdmin
          .from('profiles')
          .delete()
          .eq('id', createdUserId);

        await supabaseAdmin.auth.admin.deleteUser(
          createdUserId,
          false,
        );
      }
    }

    console.error(
      '[JDV CRM] Erreur onboarding:',
      error,
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Une erreur est survenue pendant l’inscription.',
      },
      { status: 500 },
    );
  }
}
```
