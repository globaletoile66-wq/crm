import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

interface VerifyPayload {
  transactionId?: string | number;
  organizationId?: string;
  subscriptionId?: string;
}

interface FedaPayTransaction {
  id?: number;
  reference?: string;
  merchant_reference?: string;
  amount?: number;
  status?: string;
  currency_id?: number;
  custom_metadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  approved_at?: string | null;
  updated_at?: string | null;
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

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const secretKey =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL est manquante.',
    );
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

function getFedaPayBaseUrl() {
  return process.env.FEDAPAY_ENV === 'live'
    ? 'https://api.fedapay.com'
    : 'https://sandbox-api.fedapay.com';
}

async function getFedaPayTransaction(
  transactionId: string,
): Promise<FedaPayTransaction> {
  const secretKey = process.env.FEDAPAY_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      'FEDAPAY_SECRET_KEY est manquante.',
    );
  }

  const baseUrl = getFedaPayBaseUrl();

  const response = await fetch(
    `${baseUrl}/v1/transactions/${encodeURIComponent(
      transactionId,
    )}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        'Impossible de vérifier la transaction FedaPay.',
    );
  }

  return data as FedaPayTransaction;
}

function getMetadata(
  transaction: FedaPayTransaction,
) {
  return (
    transaction.custom_metadata ??
    transaction.metadata ??
    {}
  );
}

function isApprovedStatus(status?: string) {
  return (
    typeof status === 'string' &&
    status.toLowerCase() === 'approved'
  );
}

function isCancelledStatus(status?: string) {
  if (!status) return false;

  return [
    'canceled',
    'cancelled',
    'declined',
    'failed',
    'refunded',
  ].includes(status.toLowerCase());
}

export async function POST(request: Request) {
  try {
    const body =
      (await request.json()) as VerifyPayload;

    const transactionId =
      body.transactionId !== undefined &&
      body.transactionId !== null
        ? String(body.transactionId).trim()
        : '';

    const organizationId =
      body.organizationId?.trim() || '';

    const subscriptionId =
      body.subscriptionId?.trim() || '';

    if (!transactionId) {
      return jsonError(
        'L’identifiant de transaction FedaPay est obligatoire.',
      );
    }

    if (!organizationId) {
      return jsonError(
        'L’identifiant de l’entreprise est obligatoire.',
      );
    }

    if (!subscriptionId) {
      return jsonError(
        'L’identifiant de l’abonnement est obligatoire.',
      );
    }

    const supabaseAdmin = getSupabaseAdmin();

    /*
     * ============================================================
     * 1. Vérification directe auprès de FedaPay
     * ============================================================
     *
     * On ne fait PAS confiance au status envoyé dans l'URL.
     */
    const transaction =
      await getFedaPayTransaction(transactionId);

    const metadata =
      getMetadata(transaction);

    /*
     * ============================================================
     * 2. Vérification de l'identité de la transaction
     * ============================================================
     */

    const metadataOrganizationId =
      typeof metadata.organization_id === 'string'
        ? metadata.organization_id
        : '';

    const metadataSubscriptionId =
      typeof metadata.subscription_id === 'string'
        ? metadata.subscription_id
        : '';

    if (
      metadataOrganizationId !== organizationId ||
      metadataSubscriptionId !== subscriptionId
    ) {
      console.error(
        '[JDV CRM] Transaction FedaPay ne correspondant pas aux métadonnées.',
        {
          transactionId,
          organizationId,
          subscriptionId,
          metadata,
        },
      );

      return jsonError(
        'La transaction ne correspond pas à cet abonnement.',
        403,
      );
    }

    /*
     * ============================================================
     * 3. Récupération de l'abonnement
     * ============================================================
     */

    const {
      data: subscription,
      error: subscriptionError,
    } = await supabaseAdmin
      .from('organization_subscriptions')
      .select(
        `
        id,
        organization_id,
        plan_id,
        status,
        started_at,
        expires_at
        `,
      )
      .eq('id', subscriptionId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (subscriptionError) {
      throw subscriptionError;
    }

    if (!subscription) {
      return jsonError(
        'Abonnement introuvable.',
        404,
      );
    }

    /*
     * ============================================================
     * 4. Récupération du forfait
     * ============================================================
     */

    const {
      data: plan,
      error: planError,
    } = await supabaseAdmin
      .from('subscription_plans')
      .select(
        'id, code, name, price, currency, duration_days',
      )
      .eq('id', subscription.plan_id)
      .maybeSingle();

    if (planError) {
      throw planError;
    }

    if (!plan) {
      return jsonError(
        'Forfait d’abonnement introuvable.',
        404,
      );
    }

    const typedPlan =
      plan as SubscriptionPlan;

    /*
     * ============================================================
     * 5. Vérification du montant
     * ============================================================
     *
     * On vérifie que FedaPay a réellement reçu le montant
     * attendu par JDV CRM.
     */
    if (
      typeof transaction.amount !== 'number' ||
      transaction.amount !== typedPlan.price
    ) {
      console.error(
        '[JDV CRM] Montant FedaPay différent du montant attendu.',
        {
          transactionAmount: transaction.amount,
          expectedAmount: typedPlan.price,
          planCode: typedPlan.code,
        },
      );

      return jsonError(
        'Le montant de la transaction ne correspond pas au forfait sélectionné.',
        400,
      );
    }

    /*
     * ============================================================
     * 6. Transaction non approuvée
     * ============================================================
     */

    if (!isApprovedStatus(transaction.status)) {
      /*
       * Si FedaPay confirme une annulation/refus/remboursement,
       * on synchronise le paiement interne.
       */
      if (isCancelledStatus(transaction.status)) {
        await supabaseAdmin
          .from('subscription_payments')
          .update({
            status:
              transaction.status?.toLowerCase() ===
              'refunded'
                ? 'refunded'
                : 'cancelled',
            provider_reference:
              transaction.reference ||
              transaction.id?.toString() ||
              null,
            metadata: {
              product: 'JDV_CRM_SUBSCRIPTION',
              plan_code: typedPlan.code,
              transaction_id:
                transaction.id ?? null,
              transaction_reference:
                transaction.reference ?? null,
              merchant_reference:
                transaction.merchant_reference ?? null,
              fedapay_status:
                transaction.status ?? null,
            },
          })
          .eq('organization_id', organizationId)
          .eq('subscription_id', subscriptionId)
          .eq('status', 'pending');
      }

      return NextResponse.json({
        success: false,
        verified: true,
        paid: false,
        status:
          transaction.status ?? 'unknown',
        message:
          'Le paiement n’est pas encore confirmé par FedaPay.',
      });
    }

    /*
     * ============================================================
     * 7. Protection contre les incohérences
     * ============================================================
     *
     * Une transaction approuvée doit avoir une date d'approbation
     * ou au minimum une date de mise à jour.
     */
    const activationDate =
      transaction.approved_at ||
      transaction.updated_at ||
      new Date().toISOString();

    const startedAt =
      new Date(activationDate);

    const expiresAt =
      new Date(startedAt);

    expiresAt.setDate(
      expiresAt.getDate() +
        Number(typedPlan.duration_days),
    );

    /*
     * ============================================================
     * 8. Mise à jour du paiement
     * ============================================================
     */

    const {
      error: paymentUpdateError,
    } = await supabaseAdmin
      .from('subscription_payments')
      .update({
        status: 'successful',
        paid_at: activationDate,
        provider_reference:
          transaction.reference ||
          transaction.id?.toString() ||
          null,
        metadata: {
          product: 'JDV_CRM_SUBSCRIPTION',
          plan_code: typedPlan.code,
          transaction_id:
            transaction.id ?? null,
          transaction_reference:
            transaction.reference ?? null,
          merchant_reference:
            transaction.merchant_reference ?? null,
          fedapay_status:
            transaction.status ?? null,
          verified_at:
            new Date().toISOString(),
        },
      })
      .eq('organization_id', organizationId)
      .eq('subscription_id', subscriptionId);

    if (paymentUpdateError) {
      throw paymentUpdateError;
    }

    /*
     * ============================================================
     * 9. Activation de l'abonnement
     * ============================================================
     */

    const {
      error: subscriptionUpdateError,
    } = await supabaseAdmin
      .from('organization_subscriptions')
      .update({
        status: 'active',
        started_at:
          startedAt.toISOString(),
        expires_at:
          expiresAt.toISOString(),
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .eq('organization_id', organizationId);

    if (subscriptionUpdateError) {
      throw subscriptionUpdateError;
    }

    /*
     * ============================================================
     * 10. Activation de l'entreprise
     * ============================================================
     */

    const {
      error: organizationUpdateError,
    } = await supabaseAdmin
      .from('organizations')
      .update({
        status: 'active',
        subscription_status: 'active',
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', organizationId);

    if (organizationUpdateError) {
      throw organizationUpdateError;
    }

    /*
     * ============================================================
     * 11. Réponse finale
     * ============================================================
     */

    return NextResponse.json({
      success: true,
      verified: true,
      paid: true,
      organizationId,
      subscriptionId,
      planCode: typedPlan.code,
      transactionId:
        transaction.id ?? transactionId,
      transactionStatus:
        transaction.status,
      startedAt:
        startedAt.toISOString(),
      expiresAt:
        expiresAt.toISOString(),
      message:
        'Paiement confirmé. Abonnement JDV CRM activé.',
    });
  } catch (error) {
    console.error(
      '[JDV CRM] Erreur vérification paiement:',
      error,
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Impossible de vérifier le paiement.',
      },
      { status: 500 },
    );
  }
}
